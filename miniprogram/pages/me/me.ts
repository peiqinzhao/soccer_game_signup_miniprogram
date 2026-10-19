import { run, call, toastError } from '../../utils/api'
import { getSession, setSession, Session } from '../../utils/session'
import { money } from '../../utils/format'
import { MyClubStats } from '../../utils/types'

interface PendingFine {
  _id: string
  clubId: string
  clubName: string
  venmo: string
  amountCents: number
  reasonText: string
  createdAt: number
  amountText?: string
}

Page({
  data: {
    s: null as Session | null,
    nickname: '',
    fines: [] as PendingFine[],
    stats: [] as (MyClubStats & { attendanceText: string; goalsText: string; finesText: string; moneyText: string })[],
  },

  onShow() {
    this.load()
  },

  async load() {
    try {
      const s = await getSession(true)
      this.setData({ s, nickname: s.nickname })
    } catch (e) {
      toastError(e)
      return
    }
    const [res, st] = await Promise.all([
      run<{ fines: PendingFine[] }>('myPendingFines', {}, ''),
      run<{ clubs: MyClubStats[] }>('myStats', {}, ''),
    ])
    if (res) this.setData({ fines: res.fines.map((f) => ({ ...f, amountText: money(f.amountCents) })) })
    if (st) {
      this.setData({
        stats: st.clubs.map((c) => {
          const a = c.attendance
          const parts = [`已踢 ${a.played} 场`]
          if (a.played) parts.push(`准时 ${a.onTime}`, `迟到 ${a.late}`, `未到 ${a.noShow}`)
          if (a.cancelled) parts.push(`取消 ${a.cancelled}`)
          if (a.upcoming) parts.push(`即将参加 ${a.upcoming}`)
          const f = c.fines
          return {
            ...c,
            attendanceText: parts.join(' · '),
            goalsText: `累计进球 ${c.goals || 0} · 助攻 ${c.assists || 0}`,
            finesText: f.byReason.length ? f.byReason.map((x) => `${x.reason} ${x.n} 次`).join(' · ') : '没有罚款',
            moneyText: f.totalCents ? `累计 ${money(f.totalCents)}，已付 ${money(f.paidCents)}，待付 ${money(f.pendingCents)}` : '',
          }
        }),
      })
    }
  },

  async onChooseAvatar(e: WechatMiniprogram.CustomEvent<{ avatarUrl: string }>) {
    const path = e.detail.avatarUrl
    if (!path || !this.data.s) return
    try {
      wx.showLoading({ title: '上传中' })
      const up = await wx.cloud.uploadFile({ cloudPath: `avatars/${this.data.s.openid}_${Date.now()}.jpg`, filePath: path })
      const s = await call<Session>('updateProfile', { avatar: up.fileID })
      wx.hideLoading()
      setSession(s)
      this.setData({ s })
    } catch (err) {
      wx.hideLoading()
      toastError(err)
    }
  },

  onNickInput(e: WechatMiniprogram.Input) {
    this.setData({ nickname: e.detail.value })
  },

  async saveNick() {
    const name = this.data.nickname.trim()
    if (!this.data.s || !name || name === this.data.s.nickname) return
    const s = await run<Session>('updateProfile', { nickname: name }, '保存中')
    if (!s) return
    setSession(s)
    this.setData({ s })
    wx.showToast({ title: '已保存', icon: 'success' })
  },

  openClub(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/club/club?id=${e.currentTarget.dataset.id}` })
  },

  openFines(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/fines/fines?clubId=${e.currentTarget.dataset.id}` })
  },
})
