import SwiftUI
import CryptoKit

@main
struct JarvisApp: App {
    var body: some Scene { WindowGroup { ChatView() } }
}

@MainActor
final class ChatModel: ObservableObject {
    @Published var messages: [(role: String, text: String)] = []
    @Published var sessionId = "-"
    @Published var deviceVerified = false
    @AppStorage("jarvis.server") var server = "http://192.168.1.10:3010"
    @AppStorage("jarvis.device") var deviceId = "iphone-\(UUID().uuidString.prefix(8))"

    var client: JarvisClient {
        JarvisClient(baseURL: URL(string: server)!,
                     identity: JarvisIdentity(person: "person-tobias", tenant: "tenant-personal",
                                              device: deviceId, channel: "mobile"))
    }

    func setupDevice() async {
        do {
            let key = try DeviceKeys.loadOrCreate()
            try await client.registerDevice(kind: "iphone", publicKeyPem: DeviceKeys.publicKeyPem(key))
            deviceVerified = try await client.proveDevice(key: key)
        } catch { messages.append(("system", "Enhetsoppsett feilet: \(error.localizedDescription)")) }
    }

    func send(_ text: String) async {
        messages.append(("user", text))
        do {
            if let reply = try await client.chat(text) {
                sessionId = reply.session_id
                messages.append(("jarvis", reply.reply + "  · rute: \(reply.routed)"))
            }
        } catch { messages.append(("system", "Feil: \(error.localizedDescription)")) }
    }

    /// Klasse D-godkjenning: signeres lokalt med enhetsnøkkelen; serveren
    /// verifiserer signatur/handling/parametere/utløp/engangs-nonce.
    func approveCriticalDemo() async {
        do {
            let key = try DeviceKeys.loadOrCreate()
            let approval = try ApprovalSigner.sign(action: "critical_demo", parameters: ["confirm": "true"],
                                                   deviceId: deviceId, validSeconds: 60, key: key)
            let body: [String: Any] = [
                "identity": ["person_id": "person-tobias", "tenant_id": "tenant-personal",
                             "memory_space": "personal", "session_id": sessionId,
                             "device_id": deviceId, "channel": "mobile", "auth_strength": "signed"],
                "parameters": ["confirm": "true"],
                "approval": ["action": approval.action, "parameters": approval.parameters,
                             "expires_at": approval.expires_at, "nonce": approval.nonce,
                             "approving_device_id": approval.approving_device_id,
                             "signature": approval.signature]
            ]
            struct Decision: Codable { let decision: String }
            let result: Decision = try await client.post("tools/critical-demo", body: body)
            messages.append(("system", "Godkjenning: \(result.decision)"))
        } catch { messages.append(("system", "Godkjenning avvist: \(error.localizedDescription)")) }
    }
}

struct ChatView: View {
    @StateObject var model = ChatModel()
    @State var input = ""
    var body: some View {
        NavigationStack {
            List(model.messages.indices, id: \.self) { i in
                Text(model.messages[i].text)
                    .frame(maxWidth: .infinity, alignment: model.messages[i].role == "user" ? .trailing : .leading)
            }
            HStack {
                TextField("Snakk med Jarvis …", text: $input).textFieldStyle(.roundedBorder)
                Button("Send") { let t = input; input = ""; Task { await model.send(t) } }
            }.padding()
            .navigationTitle("Jarvis \(model.deviceVerified ? "🔐" : "")")
            .toolbar {
                Button("Godkjenn demo (D)") { Task { await model.approveCriticalDemo() } }
            }
            .task { await model.setupDevice() }
        }
    }
}
