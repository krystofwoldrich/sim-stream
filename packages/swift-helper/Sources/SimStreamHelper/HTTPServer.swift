import Foundation
import Swifter

/// HTTP + WebSocket server using Swifter library.
/// Handles WebSocket on /ws, JSON endpoints, and CORS.
final class HTTPServer {
    let clientManager = ClientManager()
    private let server = HttpServer()
    private let port: UInt16

    init(port: UInt16 = 3100) {
        self.port = port
    }

    func start() throws {
        // WebSocket endpoint
        server["/ws"] = websocket(
            binary: { [weak self] session, data in
                self?.clientManager.handleMessage(from: session, data: Data(data))
            },
            connected: { [weak self] session in
                self?.clientManager.addClient(session)
            },
            disconnected: { [weak self] session in
                self?.clientManager.removeClient(session)
            }
        )

        // Config endpoint
        server["/config"] = { [weak self] request in
            let size = self?.clientManager.getScreenSize() ?? (width: 0, height: 0)
            return .ok(.json(["width": size.width, "height": size.height] as AnyObject))
        }

        // Health endpoint
        server["/health"] = { _ in
            return .ok(.json(["status": "ok"] as AnyObject))
        }

        // CORS preflight
        server.middleware.append { request in
            if request.method == "OPTIONS" {
                return HttpResponse.raw(204, "No Content", [
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type",
                ], { _ in })
            }
            return nil
        }

        try server.start(port, forceIPv4: false, priority: .userInteractive)
        print("[server] Listening on http://0.0.0.0:\(port)")
    }

    func stop() {
        clientManager.stop()
        server.stop()
    }
}
