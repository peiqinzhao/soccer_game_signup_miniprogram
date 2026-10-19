// 每次发版：把 APP_VERSION 改成上传时填的版本号，并更新 CHANGELOG。
// 老用户更新到新版本后第一次打开首页会弹一次；没有用户能感知的变化时把 CHANGELOG 留空即可（不弹）。
export const APP_VERSION = '1.0.13'

export const CHANGELOG: string[] = [
  '比赛开始后可以记录自己本场的进球和助攻（签到后）',
  '新增“数据榜”：射手榜、助攻榜、出场榜',
  '“我的”页新增意见反馈入口',
]
