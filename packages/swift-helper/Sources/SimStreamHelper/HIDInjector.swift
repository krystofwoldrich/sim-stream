import Foundation
import ObjectiveC

/// Injects touch events using the full Facebook idb approach:
/// 1. Call IndigoHIDMessageForMouseNSEvent(point, 0, 0x32, eventType, 0) to get touch data
/// 2. Extract the IndigoTouch payload
/// 3. Repackage in a properly structured dual-payload message
/// 4. Send via SimDeviceLegacyHIDClient
final class HIDInjector {
    private var hidClient: NSObject?
    private var sendSel: Selector?

    // IndigoHIDMessageForMouseNSEvent(CGPoint*, uint32, uint32, int32, uint32) -> IndigoMessage*
    private typealias IndigoMouseFunc = @convention(c) (
        UnsafePointer<CGPoint>, UInt32, UInt32, Int32, UInt32
    ) -> UnsafeMutableRawPointer?
    private var mouseFunc: IndigoMouseFunc?

    // IndigoHIDMessageForButton(uint32 buttonType, int32 eventType) -> IndigoMessage*
    private typealias IndigoButtonFunc = @convention(c) (UInt32, Int32) -> UnsafeMutableRawPointer?
    private var buttonFunc: IndigoButtonFunc?

    // Struct sizes (current Xcode — payload stride is 0xa0)
    private let payloadStride = 0xa0       // sizeof(IndigoPayload)
    private let headerSize = 0x20          // Mach header (0x18) + innerSize (4) + eventType (4)
    private let touchOffset = 0x10         // Offset of IndigoTouch within IndigoPayload
    private let touchSize = 0x90           // Size of IndigoTouch data to copy

    func setup(deviceUDID: String) throws {
        _ = dlopen("/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", RTLD_NOW)
        _ = dlopen("/Applications/Xcode.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit", RTLD_NOW)

        guard let device = FrameCapture.findSimDevice(udid: deviceUDID) else {
            throw NSError(domain: "HIDInjector", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Device \(deviceUDID) not found"])
        }

        guard let funcPtr = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "IndigoHIDMessageForMouseNSEvent") else {
            throw NSError(domain: "HIDInjector", code: 5,
                          userInfo: [NSLocalizedDescriptionKey: "IndigoHIDMessageForMouseNSEvent not found"])
        }
        self.mouseFunc = unsafeBitCast(funcPtr, to: IndigoMouseFunc.self)

        if let buttonPtr = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "IndigoHIDMessageForButton") {
            self.buttonFunc = unsafeBitCast(buttonPtr, to: IndigoButtonFunc.self)
            print("[hid] IndigoHIDMessageForButton loaded")
        } else {
            print("[hid] Warning: IndigoHIDMessageForButton not found")
        }

        guard let hidClass = NSClassFromString("_TtC12SimulatorKit24SimDeviceLegacyHIDClient") else {
            throw NSError(domain: "HIDInjector", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "SimDeviceLegacyHIDClient not found"])
        }

        let initSel = NSSelectorFromString("initWithDevice:error:")
        typealias HIDInitFunc = @convention(c) (AnyObject, Selector, AnyObject, AutoreleasingUnsafeMutablePointer<NSError?>) -> AnyObject?
        guard let initIMP = class_getMethodImplementation(hidClass, initSel) else {
            throw NSError(domain: "HIDInjector", code: 3,
                          userInfo: [NSLocalizedDescriptionKey: "Cannot get init method"])
        }
        let initFunc = unsafeBitCast(initIMP, to: HIDInitFunc.self)

        var error: NSError?
        let client = initFunc(hidClass.alloc(), initSel, device, &error)
        if let error { throw error }
        guard let clientObj = client as? NSObject else {
            throw NSError(domain: "HIDInjector", code: 4,
                          userInfo: [NSLocalizedDescriptionKey: "Failed to create HID client"])
        }

        self.hidClient = clientObj
        self.sendSel = NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:")
        print("[hid] SimDeviceLegacyHIDClient created")
        print("[hid] IndigoHIDMessageForMouseNSEvent loaded (5-param CGPoint signature)")
    }

    func sendTouch(type: String, x: Double, y: Double, screenWidth: Int, screenHeight: Int) {
        guard let client = hidClient, let sendSel = sendSel, let mouseFunc = mouseFunc else { return }

        // x, y are normalized 0..1
        var point = CGPoint(x: x, y: y)

        let eventType: Int32
        switch type {
        case "begin": eventType = 1  // ButtonEventTypeDown
        case "move":  eventType = 1  // Continued press
        case "end":   eventType = 2  // ButtonEventTypeUp
        default: return
        }

        // Step 1: Create raw IndigoMessage via the C function
        guard let rawMsg = mouseFunc(&point, 0, 0x32, eventType, 0) else {
            print("[hid] IndigoHIDMessageForMouseNSEvent returned nil for \(type)")
            return
        }

        // Step 2: Patch xRatio and yRatio on the raw message
        // IndigoTouch.xRatio at payload offset 0x1C (absolute 0x20 + 0x10 + 0x0C = 0x3C)
        // IndigoTouch.yRatio at payload offset 0x24 (absolute 0x20 + 0x10 + 0x14 = 0x44)
        rawMsg.storeBytes(of: x, toByteOffset: 0x3C, as: Double.self)
        rawMsg.storeBytes(of: y, toByteOffset: 0x44, as: Double.self)

        // Step 3: Extract IndigoTouch data from the raw message
        // Touch data starts at offset 0x30 (payload at 0x20 + touch at 0x10)
        let touchDataPtr = rawMsg + 0x30

        // Step 4: Build a new properly-structured message (idb's touchMessageWithPayload:)
        let totalSize = headerSize + payloadStride * 2
        let msg = UnsafeMutableRawPointer.allocate(byteCount: totalSize, alignment: 8)
        msg.initializeMemory(as: UInt8.self, repeating: 0, count: totalSize)

        // Header
        msg.storeBytes(of: UInt32(payloadStride), toByteOffset: 0x18, as: UInt32.self)  // innerSize
        msg.storeBytes(of: UInt8(2), toByteOffset: 0x1C, as: UInt8.self)  // eventType = IndigoEventTypeTouch

        // First payload
        let p1 = headerSize  // 0x20
        msg.storeBytes(of: UInt32(0x0b), toByteOffset: p1, as: UInt32.self)  // payloadType = digitizer
        msg.storeBytes(of: mach_absolute_time(), toByteOffset: p1 + 0x04, as: UInt64.self)  // timestamp
        // Copy touch data into payload's touch area (offset 0x10 within payload)
        memcpy(msg + p1 + touchOffset, touchDataPtr, touchSize)

        // Second payload = copy of first, then modify
        let p2 = p1 + payloadStride
        memcpy(msg + p2, msg + p1, payloadStride)
        // Override second payload's event fields (like idb does)
        msg.storeBytes(of: UInt32(1), toByteOffset: p2 + touchOffset, as: UInt32.self)
        msg.storeBytes(of: UInt32(2), toByteOffset: p2 + touchOffset + 4, as: UInt32.self)

        // Free the raw message
        free(rawMsg)

        print("[hid] Sending \(type) at (\(String(format:"%.3f",x)),\(String(format:"%.3f",y)))")

        // Step 5: Send via SimDeviceLegacyHIDClient
        typealias SendFunc = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, ObjCBool, AnyObject?, AnyObject?) -> Void
        guard let sendIMP = class_getMethodImplementation(object_getClass(client)!, sendSel) else {
            msg.deallocate()
            return
        }
        let sendFunc = unsafeBitCast(sendIMP, to: SendFunc.self)
        sendFunc(client, sendSel, msg, ObjCBool(true), nil, nil)
    }

    func sendButton(button: String, deviceUDID: String) {
        print("[hid] Sending button: \(button)")

        switch button {
        case "home":
            // Use simctl to go home — HID button injection crashes SpringBoard
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
            process.arguments = ["simctl", "launch", deviceUDID, "com.apple.springboard"]
            try? process.run()
        default:
            print("[hid] Unknown button: \(button)")
        }
    }
}
