import { call } from './api'

export interface ClubRef {
  clubId: string
  clubName: string
  role: 'owner' | 'admin' | 'member'
  name: string
}

export interface Session {
  openid: string
  nickname: string
  avatar: string
  clubs: ClubRef[]
}

let current: Session | null = null
let pending: Promise<Session> | null = null

export function getSession(force = false): Promise<Session> {
  if (current && !force) return Promise.resolve(current)
  if (!pending) {
    pending = call<Session>('login')
      .then((s) => {
        current = s
        return s
      })
      .finally(() => {
        pending = null
      })
  }
  return pending
}

export function setSession(s: Session) {
  current = s
}

const AVATAR_PROMPTED = 'avatarPrompted'

// 是否需要弹“完善资料”：没昵称必须弹；有昵称没头像只提示一次
export async function needsProfile(): Promise<boolean> {
  const s = await getSession()
  if (!s.nickname) return true
  if (s.avatar) return false
  try {
    if (wx.getStorageSync(AVATAR_PROMPTED)) return false
    wx.setStorageSync(AVATAR_PROMPTED, 1)
  } catch (e) {
    return false
  }
  return true
}
