import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

export interface ScreenshotToolValue {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  attachment?: ImageAttachmentRef
}

/** Model-visible screenshot output: caption plus a durable image block. */
export function screenshotBlocks(value: ScreenshotToolValue): Array<
  | { type: 'text'; text: string }
  | { type: 'image'; attachment: ImageAttachmentRef }
> {
  const attachment = value.attachment ?? {
    attachmentId: value.attachmentId,
    mediaType: value.mediaType,
    bytes: value.bytes,
    width: value.width,
    height: value.height,
  } as ImageAttachmentRef
  return [
    {
      type: 'text',
      text: `Screenshot captured (${value.width}×${value.height}, ${value.bytes} bytes, ${value.mediaType}, attachment ${value.attachmentId}).`,
    },
    { type: 'image', attachment },
  ]
}
