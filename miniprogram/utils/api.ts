interface ApiResult<T> {
  ok: boolean
  data?: T
  error?: string
}

export class ApiError extends Error {}

// 调用云函数 api；失败时抛 ApiError（message 可直接展示给用户）
export async function call<T = any>(action: string, params: Record<string, any> = {}): Promise<T> {
  let res: ICloud.CallFunctionResult
  try {
    res = await wx.cloud.callFunction({ name: 'api', data: { action, ...params } })
  } catch (e) {
    console.error(action, e)
    throw new ApiError('网络错误，请稍后再试')
  }
  const r = res.result as ApiResult<T>
  if (!r || !r.ok) throw new ApiError((r && r.error) || '出错了')
  return r.data as T
}

export function toastError(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg.length > 7) {
    wx.showModal({ title: '提示', content: msg, showCancel: false })
  } else {
    wx.showToast({ title: msg, icon: 'none' })
  }
}

// 带 loading 的调用；出错时弹提示并返回 null
export async function run<T = any>(action: string, params: Record<string, any> = {}, loading = '加载中'): Promise<T | null> {
  if (loading) wx.showLoading({ title: loading, mask: true })
  try {
    const data = await call<T>(action, params)
    if (loading) wx.hideLoading()
    return data
  } catch (e) {
    // 先关 loading 再弹提示，否则 hideLoading 会把 toast 一起关掉
    if (loading) wx.hideLoading()
    toastError(e)
    return null
  }
}
