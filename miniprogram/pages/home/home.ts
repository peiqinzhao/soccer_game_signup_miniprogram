import { run } from '../../utils/api'
import { getSession, ClubRef } from '../../utils/session'
import { gameTimeText, ATTENDANCE_TEXT } from '../../utils/format'
import { Game } from '../../utils/types'

interface GameCard extends Game {
  timeText: string
  localText: string
  statusText: string
  statusClass: string
  stateText: string
}

const MY_STATUS: Record<string, string> = { registered: '已报名', waitlist: '替补中', cancelled: '已缺席' }

// 我在这场的状态：结算后显示出勤结果，否则显示报名状态
function myTag(g: Game): { text: string; cls: string } {
  if (g.status === 'cancelled' || !g.myStatus) return { text: '', cls: '' }
  if (g.myAttendance) {
    return { text: ATTENDANCE_TEXT[g.myAttendance], cls: g.myAttendance === 'on_time' ? 'tag-ok' : 'tag-bad' }
  }
  const cls = g.myStatus === 'registered' ? 'tag-ok' : g.myStatus === 'cancelled' ? 'tag-bad' : 'tag-warn'
  return { text: MY_STATUS[g.myStatus] || '', cls }
}

Page({
  data: {
    loaded: false,
    tab: 'upcoming' as 'upcoming' | 'history',
    games: [] as GameCard[],
    clubs: [] as ClubRef[],
  },

  onShow() {
    this.load()
  },

  async onPullDownRefresh() {
    await this.load(true)
    wx.stopPullDownRefresh()
  },

  async load(force = false) {
    try {
      const session = await getSession(force)
      this.setData({ clubs: session.clubs })
    } catch (e) {
      // 登录失败时仍显示空页面
    }
    const res = await run<{ games: Game[] }>(
      'listGames',
      { history: this.data.tab === 'history' },
      this.data.loaded ? '' : '加载中',
    )
    if (!res) return
    const now = Date.now()
    // 近期：未结束的按开赛时间从早到晚在上；已结束/已取消的沉底，最近的在前
    const done = (g: Game) => g.status === 'cancelled' || now >= g.endAt
    const games =
      this.data.tab === 'upcoming'
        ? [...res.games].sort((a, b) => {
            if (done(a) !== done(b)) return done(a) ? 1 : -1
            return done(a) ? b.startAt - a.startAt : a.startAt - b.startAt
          })
        : res.games
    this.setData({
      loaded: true,
      games: games.map((g) => {
        const tag = myTag(g)
        return {
          ...g,
          ...gameTimeText(g),
          statusText: tag.text,
          statusClass: tag.cls,
          stateText: g.status === 'cancelled' ? '已取消' : now >= g.endAt ? '已结束' : '',
        }
      }),
    })
  },

  switchTab(e: WechatMiniprogram.TouchEvent) {
    const tab = e.currentTarget.dataset.tab
    if (tab === this.data.tab) return
    this.setData({ tab, games: [] })
    this.load()
  },

  openGame(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/game/game?id=${e.currentTarget.dataset.id}` })
  },

  openClub(e: WechatMiniprogram.TouchEvent) {
    wx.navigateTo({ url: `/pages/club/club?id=${e.currentTarget.dataset.id}` })
  },

  createClub() {
    wx.navigateTo({ url: '/pages/club-edit/club-edit' })
  },
})
