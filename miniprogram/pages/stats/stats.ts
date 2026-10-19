import { run } from '../../utils/api'
import { getSession } from '../../utils/session'
import { LeaderboardData, LeaderboardRow } from '../../utils/types'

type SortKey = 'goals' | 'assists' | 'games'

function sortRows(rows: LeaderboardRow[], sortBy: SortKey): LeaderboardRow[] {
  return [...rows].sort((a, b) => {
    if (sortBy === 'assists') {
      return b.assists - a.assists || b.goals - a.goals || b.games - a.games || a.name.localeCompare(b.name)
    }
    if (sortBy === 'games') {
      return b.games - a.games || b.goals - a.goals || b.assists - a.assists || a.name.localeCompare(b.name)
    }
    return b.goals - a.goals || b.assists - a.assists || b.games - a.games || a.name.localeCompare(b.name)
  })
}

Page({
  data: {
    loaded: false,
    clubId: '',
    clubName: '',
    clubs: [] as { clubId: string; clubName: string }[],
    rawRows: [] as LeaderboardRow[],
    rows: [] as LeaderboardRow[],
    sortBy: 'goals' as SortKey,
    totalGoals: 0,
    totalAssists: 0,
    maxGames: 0,
    myOpenid: '',
  },

  onLoad(q: Record<string, string | undefined>) {
    if (q && q.clubId) {
      this.setData({ clubId: q.clubId })
    }
  },

  onShow() {
    this.load()
  },

  async onPullDownRefresh() {
    await this.load()
    wx.stopPullDownRefresh()
  },

  async load() {
    const [res, s] = await Promise.all([
      run<LeaderboardData>('leaderboard', { clubId: this.data.clubId }, this.data.loaded ? '' : '加载中'),
      getSession().catch(() => null),
    ])
    if (!res) return
    const rawRows = res.rows || []
    const rows = sortRows(rawRows, this.data.sortBy)
    const totalGoals = rawRows.reduce((sum, r) => sum + (r.goals || 0), 0)
    const totalAssists = rawRows.reduce((sum, r) => sum + (r.assists || 0), 0)
    const maxGames = rawRows.reduce((max, r) => Math.max(max, r.games || 0), 0)
    this.setData({
      loaded: true,
      clubs: res.clubs || [],
      clubId: res.clubId || '',
      clubName: res.clubName || '',
      rawRows,
      rows,
      totalGoals,
      totalAssists,
      maxGames,
      myOpenid: s ? s.openid : '',
    })
  },

  switchClub(e: WechatMiniprogram.TouchEvent) {
    const clubId = e.currentTarget.dataset.id
    if (!clubId || clubId === this.data.clubId) return
    this.setData({ clubId })
    this.load()
  },

  changeSort(e: WechatMiniprogram.TouchEvent) {
    const sortBy = e.currentTarget.dataset.sort as SortKey
    if (!sortBy || sortBy === this.data.sortBy) return
    this.setData({
      sortBy,
      rows: sortRows(this.data.rawRows, sortBy),
    })
  },
})
