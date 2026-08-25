# copy2mihon-script (拷贝漫画转 Mihon 油猴脚本版)

在浏览器中一键将拷贝漫画（CopyManga）的书架订阅与阅读历史导出为 Mihon / Tachiyomi / Komikku 兼容的 `.tachibk` 备份文件，支持与本地已有备份进行双向智能增量合并。

---

## ✨ 特性

- **🎨 原生无感内嵌**：彻底告别突兀的浮动悬浮球与廉价毛玻璃！功能按钮**直接嵌入拷贝漫画原站顶部导航栏**与书架操作栏，与网页风格完美融为一体；
- **🚀 零安装环境**：纯前端 JavaScript 实现，无需安装 Python、uv 或编译二进制程序；
- **🔑 四重 Token 自动嗅探**：Cookie 正则解析 + `unsafeWindow` Storage/Vuex 扫描 + 双重网络 Hook + 扩展级 `GM_cookie`，打开网页秒级就绪；
- **📦 纯前端 Protobuf & Gzip**：在浏览器内存中直接完成 `.tachibk` 的解包、编解码与压缩，即点即下；
- **🔄 双向智能增量合并**：直接在网页选择手机已有的 `.tachibk` 备份，自动增量更新已读进度与历史记录，隔离保护其他图源；
- **🛡️ 确定性 SHA-1 Fallback**：针对缺失 `path_word` 的漫画生成确定性唯一标识，与 Python 版算法 100% 保持一致；
- **⚡ 极简顶部加载条**：导出时在网页最顶部展示类似 YouTube / GitHub 的纤细高质感进度条。

---

## 📥 安装脚本

### 运行环境准备
先在浏览器安装以下任意一款脚本管理器扩展：
- [Tampermonkey (篡改猴)](https://www.tampermonkey.net/)
- [Violentmonkey (暴力猴)](https://violentmonkey.github.io/)
- [ScriptCat (脚本猫)](https://scriptcat.org/)

### 安装链接
- **[点击直接安装 copy2mihon.user.js](dist/copy2mihon.user.js)**

---

## 📖 使用教程

### 1. 导出全新备份
1. 打开并登录拷贝漫画官网或镜像站（如 [mangacopy.com](https://www.mangacopy.com) 或 [copy4000.com](https://www.copy4000.com)）；
2. 在网站**顶部导航栏**（或书架页面 `/web/person/shujia` 的工具栏）直接点击 **「📦 导出 Mihon」** 按钮；
3. 弹出原质感控制弹窗，确认 Token 状态为绿色 `● Token 已就绪`；
4. 点击 **【⚡ 一键导出全部 (书架 + 历史)】**（或仅书架/仅历史）；
5. 网页顶部纤细进度条跑完后，浏览器会自动下载生成的 `copymanga_backup_YYYY-MM-DD.tachibk` 文件。

### 2. 合并到本地已有备份
1. 点击「导出到 Mihon」按钮打开面板，点击 **「合并到本地备份 (.tachibk)」**；
2. 选择手机导出的 `.tachibk` 备份文件；
3. 脚本会自动读取并拉取云端最新书架和历史记录，完成智能增量合并后自动下载 `_merged.tachibk` 文件；
4. 将合并后的文件传回手机并在 Mihon / Komikku / Tachiyomi 中恢复即可！

### 3. 导入 .tachibk 备份批量订阅到拷贝漫画书架
1. 点击「导出到 Mihon」按钮打开面板，点击 **「导入本地备份并批量订阅到拷贝」**；
2. 选择本地的 `.tachibk` 备份文件；
3. 脚本会自动解析备份中的拷贝漫画条目，对比云端已有书架（自动跳过已订阅漫画），并通过官方 API 自动批量将未订阅漫画一键添加至拷贝漫画书架！

### 4. 扩展菜单直达
您也可以直接点击浏览器右上角的油猴扩展图标，在下拉菜单中直接调用各项功能。

---

## 🌐 支持的域名

- `*.mangacopy.com`
- `*.copy4000.com`
- `*.2026copy.com`
- `*.copymanga.tv`
- `*.copymanga.site`
- `*.copymanga.org`
- `*.copymanga.com`

---

## 📄 License

MIT
