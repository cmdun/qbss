import AppKit
import Foundation

let sourcePath = CommandLine.arguments[1]
let outputDirectory = CommandLine.arguments[2]
let source = NSImage(contentsOfFile: sourcePath)!

let icons: [(String, Int)] = [
  ("icon_16x16.png", 16),
  ("icon_16x16@2x.png", 32),
  ("icon_32x32.png", 32),
  ("icon_32x32@2x.png", 64),
  ("icon_128x128.png", 128),
  ("icon_128x128@2x.png", 256),
  ("icon_256x256.png", 256),
  ("icon_256x256@2x.png", 512),
  ("icon_512x512.png", 512),
  ("icon_512x512@2x.png", 1024)
]

for (filename, size) in icons {
  let dimensions = NSSize(width: size, height: size)
  let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: size,
    pixelsHigh: size,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  )!
  bitmap.size = dimensions

  NSGraphicsContext.saveGraphicsState()
  let context = NSGraphicsContext(bitmapImageRep: bitmap)!
  NSGraphicsContext.current = context
  context.imageInterpolation = .high
  NSColor.white.setFill()
  NSRect(origin: .zero, size: dimensions).fill()
  source.draw(
    in: NSRect(origin: .zero, size: dimensions),
    from: NSRect(origin: .zero, size: source.size),
    operation: .sourceOver,
    fraction: 1
  )
  context.flushGraphics()
  NSGraphicsContext.restoreGraphicsState()

  let data = bitmap.representation(using: .png, properties: [:])!
  try data.write(to: URL(fileURLWithPath: outputDirectory).appendingPathComponent(filename))
}
