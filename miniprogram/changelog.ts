// 每次发版：把 APP_VERSION 改成上传时填的版本号，并更新 CHANGELOG。
// 老用户更新到新版本后第一次打开首页会弹一次；没有用户能感知的变化时把 CHANGELOG 留空即可（不弹）。
export const APP_VERSION = '1.0.14'

export const CHANGELOG: string[] = [
  '罚款可以按迟到、未到、临时取消分别设置金额',
  '取消截止可以设成“开场前 N 小时”（球队设置里选择）',
  '界面改成通用说法，足球、篮球、网球、羽毛球等都适用',
]
