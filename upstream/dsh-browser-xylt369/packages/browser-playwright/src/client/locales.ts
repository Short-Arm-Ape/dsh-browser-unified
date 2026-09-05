export const NS = 'settings.browserPlaywright'

export const zh: Record<string, string> = {
  title: '浏览器窗口',
  description: '窗口模式与反检测。这些项在下次启动浏览器时生效。',
  windowVisibility: '窗口模式',
  stealth: '轻量反检测补丁',
  allowFakeIp: '允许代理 fake-ip DNS（Clash/Surge 198.18）',
  restart: '保存后请重启 dsh，或等下一次启动浏览器时生效。',
  save: '保存',
  saving: '保存中…',
  discard: '放弃',
  saveFailed: '保存失败，请重试。',
  unsaved: '未保存',
  readOnly: '当前只读。',
  reset: '恢复默认',
  visible: '可见窗口',
  hidden: '隐藏窗口',
  headless: '无头',
}

export const en: Record<string, string> = {
  title: 'Browser window',
  description: 'Window mode and anti-detection. These apply the next time the browser launches.',
  windowVisibility: 'Window mode',
  stealth: 'Lightweight stealth patch',
  allowFakeIp: 'Allow proxy fake-ip DNS (Clash/Surge 198.18)',
  restart: 'Restart dsh after saving, or wait until the next browser launch.',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  saveFailed: 'Save failed. Try again.',
  unsaved: 'Unsaved',
  readOnly: 'Read-only right now.',
  reset: 'Reset',
  visible: 'Visible window',
  hidden: 'Hidden window',
  headless: 'Headless',
}
