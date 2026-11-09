/** 独立桌面插件的构建入口与发布资源。 */
export const desktopPlugins = [
  { id: 'floating-ball', name: 'dsh-floating-ball', entry: 'desktop-floating-plugin', title: 'Floating ball', titleZh: '悬浮球',
    description: 'Desktop floating assistant with conversation, model and permission controls',
    assets: ['floating.html', 'floating.js', 'floating.css', 'floating-mentions.css', 'floating-mentions.tw.css', 'deepseek-avatar-square.gif', 'observation-frame.html', 'observation-frame.css', 'selection-markdown.js', 'shell-theme.js', 'assets/window-material.css'],
    dependencies: [], native: ['macos-sck-napi.node', 'libmacos-sck-capture.dylib'] },
  { id: 'selection-toolbar', name: 'dsh-selection-toolbar', entry: 'desktop-selection-plugin', title: 'Selection toolbar', titleZh: '划词工具栏',
    description: 'Desktop text selection, translation and assistant result toolbar',
    assets: ['selection-toolbar.html', 'selection-toolbar.js', 'selection-toolbar.css', 'selection-ui.tw.css', 'selection-result.html', 'selection-result.js', 'selection-result.css', 'selection-thinking.png', 'selection-done.png', 'selection-markdown.js', 'shell-theme.js', 'assets/window-material.css'],
    dependencies: ['koffi', 'turndown', 'pdfjs-dist', '@napi-rs/canvas'], native: ['macos-selection-napi.node', 'libmacos-selection.dylib'] },
  { id: 'capture', name: 'dsh-capture', entry: 'desktop-capture-plugin', title: 'Screenshot and recording', titleZh: '截图和录屏',
    description: 'Independent desktop region screenshots, annotations and recording controls',
    assets: ['capture.html', 'capture.js', 'capture.css', 'capture.tw.css', 'shell-theme.js', 'assets/window-material.css'], dependencies: [], native: [] },
]
