// 订阅消息模板（小程序后台 → 订阅消息 → 我的模板）。
// 模板 ID 需与 miniprogram/config.ts 一致；字段名按模板“详情”里的 {{xxx.DATA}} 填写。
// thing 类字段最多 20 个字，time/date 用“2026年10月4日 10:00”格式。留空 ID 则不发送。
const cut = (s, n = 20) => String(s || '').slice(0, n)

module.exports = {
  // 活动候补成功通知（模板编号 17230）
  PROMOTED_TEMPLATE_ID: 'XEQgrPR0faFT4-A1NoHX_GhvEAepjXSY78BXA2D6A58',
  buildPromotedData({ memberName, gameTitle, startText, venueName }) {
    return {
      thing1: { value: cut(memberName) }, // 候补姓名
      thing2: { value: cut(gameTitle) }, // 活动名称
      time4: { value: startText }, // 活动时间
      thing5: { value: cut(venueName) }, // 活动地址
      thing6: { value: '已由替补转为正式报名，请准时到场' }, // 温馨提示
    }
  },

  // 活动报名通知（模板编号 3493），用作报名开放提醒
  OPEN_TEMPLATE_ID: 'rvKeXjNUszVtwjExgtUn4PuX978wjl4xyIbseB2hoQ8',
  buildOpenData({ gameTitle, startText, venueName }) {
    return {
      thing1: { value: cut(gameTitle) }, // 活动名称
      thing3: { value: cut(venueName) }, // 活动地点
      date5: { value: startText }, // 活动时间
      thing6: { value: '报名已开放，快来报名' }, // 备注
    }
  },

  // 活动变更通知（模板编号 1685）
  CHANGED_TEMPLATE_ID: 'iP2Zxq-s-mHoPwrI25riKO9o4i--_Q7Vqslo67-9n4M',
  buildChangedData({ gameTitle, startText, venueName, cancelled, reason, timeChanged, venueChanged }) {
    const detail = cancelled
      ? `已取消：${reason}`
      : [timeChanged && '时间变更', venueChanged && '场地变更'].filter(Boolean).join('、')
    return {
      thing2: { value: cut(gameTitle) }, // 活动名称
      date4: { value: startText }, // 活动时间变更
      thing5: { value: cut(venueName) }, // 地址变更
      thing6: { value: cut(detail) }, // 修改详情
      thing10: { value: cancelled ? '比赛已取消，请勿前往' : '请以小程序内最新安排为准' }, // 备注
    }
  },
}
