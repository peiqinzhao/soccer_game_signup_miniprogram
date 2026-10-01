// 页面之间传一次性消息（例如编辑页保存后，让比赛页弹出“转发到群”提示）
const box: Record<string, unknown> = {}

export function setFlash(key: string, value: unknown) {
  box[key] = value
}

export function takeFlash<T>(key: string): T | undefined {
  const v = box[key] as T | undefined
  delete box[key]
  return v
}
