import { run } from '../../utils/api'
import { formatText } from '../../utils/format'
import { GameDetail, TeamsView } from '../../utils/types'

Page({
  data: {
    id: '',
    t: null as TeamsView | null,
    myOpenid: '',
    isAdmin: false,
    ended: false, // 比赛结束前管理员都可以重新分队、重排守门员
    formatStr: '',
  },

  timer: 0 as number,

  onLoad(q: Record<string, string | undefined>) {
    this.setData({ id: q.id || '' })
  },

  onShow() {
    this.load()
    // 现场陆续有人签到，定时刷新
    this.timer = setInterval(() => this.load(true), 15 * 1000) as unknown as number
  },

  onHide() {
    clearInterval(this.timer)
  },

  onUnload() {
    clearInterval(this.timer)
  },

  async onPullDownRefresh() {
    await this.load()
    wx.stopPullDownRefresh()
  },

  async load(silent = false) {
    const d = await run<GameDetail>('getGame', { gameId: this.data.id }, silent || this.data.t ? '' : '加载中')
    if (!d || !d.teams) return
    this.setData({
      t: d.teams,
      myOpenid: d.me.openid,
      isAdmin: d.me.isAdmin,
      ended: d.serverNow >= d.game.endAt,
      formatStr: formatText(d.game.teamSize, d.game.teamCount),
    })
  },

  async onReshuffle() {
    const r = await wx.showModal({ title: '重新随机', content: '首批分队的人重新随机分配，后来签到的人不变。守门员顺序也会重排。' })
    if (r.confirm && (await run('reshuffleTeams', { gameId: this.data.id }, '分队中'))) this.load()
  },

  async onReshuffleGk(e: WechatMiniprogram.TouchEvent) {
    const team: string = e.currentTarget.dataset.team
    const r = await wx.showModal({ title: `重排 ${team} 队守门员`, content: '只重新随机这一队的守门员顺序，分队不变。' })
    if (r.confirm && (await run('reshuffleGoalkeepers', { gameId: this.data.id, team }, '重排中'))) this.load()
  },

  onShareAppMessage() {
    return { title: `分队结果（${this.data.formatStr}）`, path: `/pages/teams/teams?id=${this.data.id}` }
  },
})
