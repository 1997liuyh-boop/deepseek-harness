/** 从 PNG 或 JPEG 头读取观察图像尺寸，并拒绝无法可靠操作的退化截图。 */







/** 图像头声明的有效像素宽度与高度。 */
export interface ObservationRasterSize {
  readonly width: number
  readonly height: number
}


/** 允许作为可操作观察图像的最小像素边长。 */
export const MIN_USABLE_OBSERVATION_EDGE = 2

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

function viewOf(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength)
}

function pngSize(data: Uint8Array): ObservationRasterSize | undefined {
  if (data.length < 24) return undefined
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (data[i] !== PNG_SIGNATURE[i]) return undefined
  }
  if (data[12] !== 0x49 || data[13] !== 0x48 || data[14] !== 0x44 || data[15] !== 0x52) return undefined
  const view = viewOf(data)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  if (width < 1 || height < 1) return undefined
  return { width, height }
}

function isStartOfFrame(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

function jpegSize(data: Uint8Array): ObservationRasterSize | undefined {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return undefined
  const view = viewOf(data)
  let index = 2
  while (index + 1 < data.length) {
    if (data[index] !== 0xff) return undefined
    while (index < data.length && data[index] === 0xff) index += 1
    if (index >= data.length) return undefined
    const marker = view.getUint8(index)
    index += 1
    if (marker === 0xd9 || marker === 0xda) return undefined
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue
    if (index + 1 >= data.length) return undefined
    const length = view.getUint16(index)
    if (length < 2 || index + length > data.length) return undefined
    if (isStartOfFrame(marker)) {
      if (length < 7) return undefined
      const height = view.getUint16(index + 3)
      const width = view.getUint16(index + 5)
      if (width < 1 || height < 1) return undefined
      return { width, height }
    }
    index += length
  }
  return undefined
}






/**
 * 从 PNG 或 JPEG 头部解析正数图像尺寸，不执行完整图像解码。
 * @param data - 原始图像字节。
 * @returns 可识别的图像尺寸；头部不完整、格式不支持或尺寸无效时为 undefined。
 */
export function observationRasterSize(data: Uint8Array): ObservationRasterSize | undefined {
  return pngSize(data) ?? jpegSize(data)
}






/**
 * 判断图像头是否声明了达到最小边长的可用观察尺寸。
 * @param data - 待附加给模型的原始截图。
 * @returns 格式可识别且宽高均达到观察下限时为 true。
 */
export function isUsableObservationRaster(data: Uint8Array): boolean {
  const size = observationRasterSize(data)
  return size !== undefined
    && size.width >= MIN_USABLE_OBSERVATION_EDGE
    && size.height >= MIN_USABLE_OBSERVATION_EDGE
}
