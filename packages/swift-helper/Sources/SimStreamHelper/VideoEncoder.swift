import Foundation
import VideoToolbox
import CoreMedia
import CoreVideo

final class VideoEncoder {
    private var session: VTCompressionSession?
    private var onEncodedFrame: ((Data, Bool) -> Void)?
    private var onParameterSets: ((_ sps: Data, _ pps: Data) -> Void)?
    private var sentParameterSets = false

    func setup(width: Int32, height: Int32, fps: Int,
               onParameterSets: @escaping (_ sps: Data, _ pps: Data) -> Void,
               onEncodedFrame: @escaping (Data, Bool) -> Void) throws {
        self.onEncodedFrame = onEncodedFrame
        self.onParameterSets = onParameterSets

        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: width,
            height: height,
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: [
                kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: true
            ] as CFDictionary,
            imageBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey: width,
                kCVPixelBufferHeightKey: height,
            ] as CFDictionary,
            compressedDataAllocator: nil,
            outputCallback: nil,
            refcon: nil,
            compressionSessionOut: &session
        )

        guard status == noErr, let session else {
            throw NSError(domain: "VideoEncoder", code: Int(status),
                          userInfo: [NSLocalizedDescriptionKey: "Failed to create compression session"])
        }

        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Main_AutoLevel)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: NSNumber(value: fps)) // Key frame every 1 second
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: NSNumber(value: 1.0))
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: fps))
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: 4_000_000))

        let dataRateLimits: [NSNumber] = [
            NSNumber(value: 6_000_000 / 8), // bytes
            NSNumber(value: 1),              // seconds
        ]
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_DataRateLimits, value: dataRateLimits as CFArray)

        VTCompressionSessionPrepareToEncodeFrames(session)
    }

    private var forceNextKeyFrame = true // Force first frame to be a key frame

    func requestKeyFrame() {
        forceNextKeyFrame = true
    }

    func encode(pixelBuffer: CVPixelBuffer, timestamp: CMTime) {
        guard let session else { return }

        var frameProps: CFDictionary? = nil
        if forceNextKeyFrame {
            forceNextKeyFrame = false
            frameProps = [
                kVTEncodeFrameOptionKey_ForceKeyFrame: true
            ] as CFDictionary
        }

        VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: pixelBuffer,
            presentationTimeStamp: timestamp,
            duration: .invalid,
            frameProperties: frameProps,
            infoFlagsOut: nil
        ) { [weak self] status, _, sampleBuffer in
            guard status == noErr, let sampleBuffer, let self else { return }
            self.processSampleBuffer(sampleBuffer)
        }
    }

    private func processSampleBuffer(_ sampleBuffer: CMSampleBuffer) {
        guard let dataBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }

        let isKeyFrame: Bool = {
            guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[CFString: Any]],
                  let first = attachments.first else { return true }
            return !(first[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
        }()

        // Extract and send SPS/PPS with every key frame (needed for late-joining peers)
        if isKeyFrame {
            if let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer) {
                extractParameterSets(formatDesc)
            }
        }

        // Extract raw H.264 data
        var totalLength = 0
        var dataPointer: UnsafeMutablePointer<CChar>?
        CMBlockBufferGetDataPointer(dataBuffer, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &totalLength, dataPointerOut: &dataPointer)

        guard let dataPointer, totalLength > 0 else { return }

        // Convert AVCC (length-prefixed) NALUs to Annex B (start code prefixed)
        var annexBData = Data()
        let startCode: [UInt8] = [0x00, 0x00, 0x00, 0x01]
        var offset = 0

        while offset < totalLength - 4 {
            var naluLength: UInt32 = 0
            memcpy(&naluLength, dataPointer + offset, 4)
            naluLength = naluLength.bigEndian
            offset += 4

            guard offset + Int(naluLength) <= totalLength else { break }

            annexBData.append(contentsOf: startCode)
            annexBData.append(Data(bytes: dataPointer + offset, count: Int(naluLength)))
            offset += Int(naluLength)
        }

        onEncodedFrame?(annexBData, isKeyFrame)
    }

    private func extractParameterSets(_ formatDesc: CMFormatDescription) {
        var spsPtr: UnsafePointer<UInt8>?
        var spsSize: Int = 0
        var ppsPtr: UnsafePointer<UInt8>?
        var ppsSize: Int = 0

        var status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            formatDesc, parameterSetIndex: 0,
            parameterSetPointerOut: &spsPtr, parameterSetSizeOut: &spsSize,
            parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)

        guard status == noErr, let spsPtr else { return }

        status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            formatDesc, parameterSetIndex: 1,
            parameterSetPointerOut: &ppsPtr, parameterSetSizeOut: &ppsSize,
            parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)

        guard status == noErr, let ppsPtr else { return }

        let sps = Data(bytes: spsPtr, count: spsSize)
        let pps = Data(bytes: ppsPtr, count: ppsSize)

        sentParameterSets = true
        onParameterSets?(sps, pps)
    }

    func stop() {
        if let session {
            VTCompressionSessionInvalidate(session)
        }
        session = nil
    }
}
