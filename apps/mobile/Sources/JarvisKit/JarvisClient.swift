import Foundation
import CryptoKit

// MARK: - Modeller (speiler backend-kontraktene i packages/contracts)

public struct JarvisIdentity: Codable, Sendable {
    public var person_id: String
    public var tenant_id: String
    public var device_id: String
    public var memory_space: String
    public var channel: String
    public init(person: String, tenant: String, device: String, space: String = "personal", channel: String = "mobile") {
        person_id = person; tenant_id = tenant; device_id = device; memory_space = space; self.channel = channel
    }
}

public struct ChatReply: Codable, Sendable {
    public let reply: String
    public let routed: String
    public let session_id: String
    public let task_id: String?
}

public struct SignedApproval: Codable, Sendable {
    public let action: String
    public let parameters: [String: String]
    public let expires_at: String
    public let nonce: String
    public let approving_device_id: String
    public let signature: String
}

// MARK: - Enhetsnøkler
// Ed25519 (Curve25519) i Keychain: kompatibel med backendens verifisering i dag.
// Secure Enclave (P-256) er forberedt, men krever ECDSA-støtte i backendens
// approval-verifier først - se APPLE_PHASE8_CHECKLIST.

public enum DeviceKeys {
    static let tag = "com.tsworkflow.jarvis.devicekey"

    public static func loadOrCreate() throws -> Curve25519.Signing.PrivateKey {
        if let data = KeychainStore.read(tag: tag) {
            return try Curve25519.Signing.PrivateKey(rawRepresentation: data)
        }
        let key = Curve25519.Signing.PrivateKey()
        try KeychainStore.write(tag: tag, data: key.rawRepresentation)
        return key
    }

    /// PEM (SPKI) for registrering mot POST /devices/register
    public static func publicKeyPem(_ key: Curve25519.Signing.PrivateKey) -> String {
        var der = Data([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00])
        der.append(key.publicKey.rawRepresentation)
        let b64 = der.base64EncodedString(options: [.lineLength64Characters, .endLineWithLineFeed])
        return "-----BEGIN PUBLIC KEY-----\n\(b64)\n-----END PUBLIC KEY-----\n"
    }
}

enum KeychainStore {
    static func read(tag: String) -> Data? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrAccount as String: tag,
                                    kSecReturnData as String: true]
        var out: CFTypeRef?
        return SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
    }
    static func write(tag: String, data: Data) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrAccount as String: tag,
                                    kSecValueData as String: data,
                                    kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        SecItemDelete(query as CFDictionary)
        guard SecItemAdd(query as CFDictionary, nil) == errSecSuccess else {
            throw NSError(domain: "Keychain", code: -1)
        }
    }
}

// MARK: - Godkjenningssignering (klasse D)
// Kanonisk JSON MÅ matche backendens approvalSigningBytes: nøkler i rekkefølgen
// action, approving_device_id, expires_at, nonce, parameters (sorterte nøkler).

public enum ApprovalSigner {
    public static func sign(action: String, parameters: [String: String], deviceId: String,
                            validSeconds: TimeInterval, key: Curve25519.Signing.PrivateKey) throws -> SignedApproval {
        let expires = ISO8601DateFormatter().string(from: Date().addingTimeInterval(validSeconds))
        let nonce = "nonce-\(UUID().uuidString.lowercased())"
        let sortedParams = parameters.keys.sorted()
            .map { "\(jsonString($0)):\(jsonString(parameters[$0]!))" }.joined(separator: ",")
        let canonical = "{\"action\":\(jsonString(action)),\"approving_device_id\":\(jsonString(deviceId)),\"expires_at\":\(jsonString(expires)),\"nonce\":\(jsonString(nonce)),\"parameters\":{\(sortedParams)}}"
        let signature = try key.signature(for: Data(canonical.utf8)).base64EncodedString()
        return SignedApproval(action: action, parameters: parameters, expires_at: expires,
                              nonce: nonce, approving_device_id: deviceId, signature: signature)
    }
    static func jsonString(_ s: String) -> String {
        let data = try! JSONEncoder().encode(s)
        return String(data: data, encoding: .utf8)!
    }
}

// MARK: - API-klient
// Reconnect/offline uten doble handlinger: hver sendte melding får en lokal
// utterance-id; en melding som er bekreftet sendt re-sendes aldri (persistert
// i UserDefaults). Ingen provider-secrets i klienten - kun enhetsauth.

public actor JarvisClient {
    let baseURL: URL
    public var identity: JarvisIdentity
    private var completedUtterances: Set<String>

    public init(baseURL: URL, identity: JarvisIdentity) {
        self.baseURL = baseURL
        self.identity = identity
        completedUtterances = Set(UserDefaults.standard.stringArray(forKey: "jarvis.completed") ?? [])
    }

    public func health() async throws -> Bool {
        let (_, response) = try await URLSession.shared.data(from: baseURL.appendingPathComponent("health"))
        return (response as? HTTPURLResponse)?.statusCode == 200
    }

    public func chat(_ message: String, utteranceId: String = UUID().uuidString) async throws -> ChatReply? {
        guard !completedUtterances.contains(utteranceId) else { return nil } // aldri dobbel handling
        var body: [String: Any] = ["message": message]
        for (k, v) in try dict(identity) { body[k] = v }
        let reply: ChatReply = try await post("chat", body: body)
        completedUtterances.insert(utteranceId)
        UserDefaults.standard.set(Array(completedUtterances), forKey: "jarvis.completed")
        return reply
    }

    public func registerDevice(kind: String, publicKeyPem: String) async throws {
        var identityBody = try dict(identity)
        identityBody["session_id"] = "sess-device-setup"
        identityBody["auth_strength"] = "active"
        let _: [String: String] = try await post("devices/register", body: [
            "identity": identityBody,
            "device": ["device_id": identity.device_id, "kind": kind, "public_key_pem": publicKeyPem]
        ])
    }

    public func proveDevice(key: Curve25519.Signing.PrivateKey) async throws -> Bool {
        struct Challenge: Codable { let challenge: String }
        let challenge: Challenge = try await post("devices/challenge", body: ["device_id": identity.device_id])
        let signature = try key.signature(for: Data(challenge.challenge.utf8)).base64EncodedString()
        struct Verified: Codable { let verified: Bool }
        let result: Verified = try await post("devices/challenge/verify", body: [
            "tenant_id": identity.tenant_id, "device_id": identity.device_id,
            "challenge": challenge.challenge, "signature": signature
        ])
        return result.verified
    }

    func post<T: Decodable>(_ path: String, body: [String: Any]) async throws -> T {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode < 300 else {
            throw NSError(domain: "Jarvis", code: (response as? HTTPURLResponse)?.statusCode ?? -1,
                          userInfo: [NSLocalizedDescriptionKey: String(data: data, encoding: .utf8) ?? ""])
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func dict(_ identity: JarvisIdentity) throws -> [String: Any] {
        let data = try JSONEncoder().encode(identity)
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }
}
