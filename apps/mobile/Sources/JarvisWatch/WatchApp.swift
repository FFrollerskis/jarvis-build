import SwiftUI
import CryptoKit

// Tynn Watch-klient (VOICE_ARCHITECTURE/fase 8): varsler, korte svar og
// klasse D-godkjenning. Ingen Jarvis-hjerne/minne på klokken - alt bor i Core.
@main
struct JarvisWatchApp: App {
    var body: some Scene { WindowGroup { WatchHome() } }
}

struct WatchHome: View {
    @AppStorage("jarvis.server") var server = "http://192.168.1.10:3010"
    @AppStorage("jarvis.device") var deviceId = "watch-\(UUID().uuidString.prefix(8))"
    @State var status = "…"

    var client: JarvisClient {
        JarvisClient(baseURL: URL(string: server)!,
                     identity: JarvisIdentity(person: "person-tobias", tenant: "tenant-personal",
                                              device: deviceId, channel: "watch"))
    }

    var body: some View {
        VStack(spacing: 8) {
            Text("Jarvis").font(.headline)
            Text(status).font(.footnote).lineLimit(4)
            Button("Status") { Task { await quick("status") } }
            Button("Godkjenn (D)") { Task { await approve() } }
        }
        .task { await registerOnce() }
    }

    func registerOnce() async {
        if let key = try? DeviceKeys.loadOrCreate() {
            try? await client.registerDevice(kind: "watch", publicKeyPem: DeviceKeys.publicKeyPem(key))
        }
    }

    func quick(_ text: String) async {
        do { status = try await client.chat(text)?.reply ?? "(dedupe)" }
        catch { status = "Feil: \(error.localizedDescription)" }
    }

    func approve() async {
        do {
            let key = try DeviceKeys.loadOrCreate()
            let approval = try ApprovalSigner.sign(action: "critical_demo", parameters: ["confirm": "true"],
                                                   deviceId: deviceId, validSeconds: 60, key: key)
            struct Decision: Codable { let decision: String }
            let result: Decision = try await client.post("tools/critical-demo", body: [
                "identity": ["person_id": "person-tobias", "tenant_id": "tenant-personal",
                             "memory_space": "personal", "session_id": "sess-watch",
                             "device_id": deviceId, "channel": "watch", "auth_strength": "signed"],
                "parameters": ["confirm": "true"],
                "approval": ["action": approval.action, "parameters": approval.parameters,
                             "expires_at": approval.expires_at, "nonce": approval.nonce,
                             "approving_device_id": approval.approving_device_id,
                             "signature": approval.signature]
            ])
            status = "Godkjenning: \(result.decision)"
        } catch { status = "Avvist: \(error.localizedDescription)" }
    }
}
