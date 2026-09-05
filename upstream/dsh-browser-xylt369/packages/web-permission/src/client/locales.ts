export const NS = 'settings.webPermission'

export const zh: Record<string, string> = {
  title: '网页权限门',
  description: '控制浏览器与抓取工具可以访问哪些主机。改动立即生效。',
  allowHosts: '允许的主机（每行一个）',
  denyHosts: '拒绝的主机（每行一个）',
  gatedTools: '受管控的工具名（每行一个）',
  defaultAction: '名单外主机的默认动作',
  remember: '批准后写入允许名单',
  save: '保存',
  saving: '保存中…',
  discard: '放弃',
  saveFailed: '保存失败，请重试。',
  unsaved: '未保存',
  readOnly: '当前只读。',
  reset: '恢复默认',
  allow: '允许',
  ask: '询问',
}

export const en: Record<string, string> = {
  title: 'Web permission gate',
  description: 'Controls which hosts browser and fetch tools may reach. Changes apply live.',
  allowHosts: 'Allowed hosts (one per line)',
  denyHosts: 'Denied hosts (one per line)',
  gatedTools: 'Gated tool names (one per line)',
  defaultAction: 'Default action for hosts on neither list',
  remember: 'Remember approved hosts on the allow list',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  saveFailed: 'Save failed. Try again.',
  unsaved: 'Unsaved',
  readOnly: 'Read-only right now.',
  reset: 'Reset',
  allow: 'Allow',
  ask: 'Ask',
}
