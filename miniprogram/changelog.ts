// 每次发版：把 APP_VERSION 改成上传时填的版本号，并更新 CHANGELOG。
// 老用户更新到新版本后第一次打开首页会弹一次；没有用户能感知的变化时把 CHANGELOG 留空即可（不弹）。
export const APP_VERSION = '2.0.2'

export const CHANGELOG: string[] = [
  '签到码刷新间隔可以在球队设置里调整（默认 5 分钟）',
  '比赛当天修改场地的签到范围，会马上对这场比赛生效',
]
