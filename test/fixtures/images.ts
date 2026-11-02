// Real one-pixel images keep provider-boundary fixtures decodable.
export const pngImageBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC"

export const secondPngImageBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgYPgPAAEDAQBdlO9aAAAAAElFTkSuQmCC"

export const webpImageBase64 =
  "UklGRjoAAABXRUJQVlA4IC4AAACQAQCdASoBAAEAAUAmJaACdLoAA5gA/vtV4/+lwf/S4P/pcH/pcH8bss4bpAAA"

export const jpegImageBase64 =
  "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCewFIh3//Z"

export const gifImageBase64 =
  "R0lGODlhAQABAIAAAExpcQAA/yH5BAUAAAAALAAAAAABAAEAAAICTAEAOw=="

// Trailing bytes vary transport size without corrupting the PNG pixels.
export function pngImageBytes(size?: number): Buffer {
  const image = Buffer.from(pngImageBase64, "base64")
  const bytes = Buffer.alloc(Math.max(size ?? image.length, image.length))
  image.copy(bytes)
  return bytes
}
