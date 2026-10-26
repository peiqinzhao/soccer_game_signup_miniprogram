// 每次发版：把 APP_VERSION 改成上传时填的版本号，并更新 CHANGELOG。
// 老用户更新到新版本后第一次打开首页会弹一次；没有用户能感知的变化时把 CHANGELOG 留空即可（不弹）。
export const APP_VERSION = '1.0.16'

export const CHANGELOG: string[] = [
  '报名后不来叫“退出报名”，名单里叫“已退出”，不再和“比赛取消”混淆',
  '场地签到范围最小可以设到 10 米',
]
