import Foundation

final class SocketServer {
    private let socketPath: String
    private var serverFD: Int32 = -1
    private var clientFDs: [Int32] = []
    private let queue = DispatchQueue(label: "socket-server", attributes: .concurrent)
    private var onMessage: ((MessageType, Data) -> Void)?

    init(socketPath: String) {
        self.socketPath = socketPath
    }

    func start(onMessage: @escaping (MessageType, Data) -> Void) throws {
        self.onMessage = onMessage

        // Remove existing socket file
        unlink(socketPath)

        serverFD = socket(AF_UNIX, SOCK_STREAM, 0)
        guard serverFD >= 0 else {
            throw NSError(domain: "SocketServer", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed to create socket"])
        }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        socketPath.withCString { ptr in
            withUnsafeMutablePointer(to: &addr.sun_path) { pathPtr in
                let bound = pathPtr.withMemoryRebound(to: CChar.self, capacity: 104) { dest in
                    strncpy(dest, ptr, 104)
                    return true
                }
                _ = bound
            }
        }

        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                bind(serverFD, sockPtr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0 else {
            throw NSError(domain: "SocketServer", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to bind: \(String(cString: strerror(errno)))"])
        }

        guard listen(serverFD, 5) == 0 else {
            throw NSError(domain: "SocketServer", code: 3, userInfo: [NSLocalizedDescriptionKey: "Failed to listen"])
        }

        print("[socket] Listening on \(socketPath)")
        acceptClients()
    }

    private func acceptClients() {
        queue.async { [weak self] in
            guard let self else { return }
            while true {
                let clientFD = accept(self.serverFD, nil, nil)
                guard clientFD >= 0 else { continue }
                print("[socket] Client connected (fd=\(clientFD))")
                self.clientFDs.append(clientFD)
                self.readFromClient(clientFD)
            }
        }
    }

    private func readFromClient(_ fd: Int32) {
        queue.async { [weak self] in
            guard let self else { return }
            var parser = MessageParser()
            let bufferSize = 65536
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
            defer { buffer.deallocate() }

            while true {
                let bytesRead = read(fd, buffer, bufferSize)
                if bytesRead <= 0 {
                    print("[socket] Client disconnected (fd=\(fd))")
                    self.clientFDs.removeAll { $0 == fd }
                    close(fd)
                    return
                }
                parser.append(Data(bytes: buffer, count: bytesRead))
                while let (type, payload) = parser.nextMessage() {
                    self.onMessage?(type, payload)
                }
            }
        }
    }

    func broadcast(type: MessageType, payload: Data) {
        let message = encodeMessage(type: type, payload: payload)
        for fd in clientFDs {
            message.withUnsafeBytes { ptr in
                let base = ptr.baseAddress!
                var totalWritten = 0
                while totalWritten < message.count {
                    let written = write(fd, base + totalWritten, message.count - totalWritten)
                    if written <= 0 { break }
                    totalWritten += written
                }
            }
        }
    }

    func stop() {
        for fd in clientFDs { close(fd) }
        clientFDs.removeAll()
        if serverFD >= 0 { close(serverFD) }
        unlink(socketPath)
    }
}
