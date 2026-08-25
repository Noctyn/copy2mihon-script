# copy2mihon-script (拷贝漫画转 Mihon 油猴脚本版)

在浏览器中一键将拷贝漫画（CopyManga）的书架订阅与阅读历史导出为 Mihon / Tachiyomi / Komikku 兼容的 `.tachibk` 备份文件，支持与手机现有备份进行双向智能增量合并。

---

## ✨ 特性

- **🚀 零安装环境**：纯前端 JavaScript 实现，无需安装 Python、uv 或编译二进制程序；
- **🔑 自动嗅探 Token**：只要在浏览器登录了拷贝漫画，脚本自动识别提取 Token，无需手动抓包；
- **📦 纯前端 Protobuf & Gzip**：在浏览器内存中直接完成 `.tachibk` 的解包、编解码与压缩，即点即下；
- **🔄 双向智能增量合并**：直接在网页选择手机已有的 `.tachibk` 备份，自动增量更新已读进度与历史记录，隔离保护其他图源；
- **🛡️ 确定性 SHA-1 Fallback**：针对缺失 `path_word` 的漫画生成确定性唯一标识，与 Python 版算法 100% 保持一致；
- **🎨 现代化悬浮窗 UI**：极简半透明悬浮球 + 卡片面板，带动态进度条与实时日志。

---

## 📥 安装脚本

### 运行环境准备
先在浏览器安装以下任意一款脚本管理器扩展：
- [Tampermonkey (篡改猴)](https://www.tampermonkey.net/)
- [Violentmonkey (暴力猴)](https://violentmonkey.github.io/)
- [ScriptCat (脚本猫)](https://scriptcat.org/)

### 安装链接
安装扩展后，点击下方链接安装脚本：
- **[点击直接安装 copy2mihon.user.js](dist/copy2mihon.user.js)**

---

## 📖 使用教程

### 1. 导出全新备份
1. 打开并登录拷贝漫画官网或任意镜像站（如 [mangacopy.com](https://www.mangacopy.com) 或 [copy4000.com](https://www.copy4000.com)）；
2. 页面右下角会出现 **📖 悬浮球**，点击展开控制面板；
3. 确认 Token 状态为绿色 `● Token: ...`；
4. 点击 **【📥 导出全部 (书架 + 历史)】**（或仅书架/仅历史）；
5. 进度条跑完后，浏览器会自动下载生成的 `copymanga_backup_YYYY-MM-DD.tachibk` 文件。

### 2. 合并到手机已有备份
1. 打开控制面板，点击 **【🔄 合并至本地 .tachibk 备份】**；
2. 在弹出的文件选择框中选择您手机导出的 `.tachibk` 备份文件；
3. 脚本会自动读取并拉取云端最新书架和历史记录，完成智能增量合并后自动下载 `_merged.tachibk` 文件；
4. 将合并后的文件传回手机并在 Mihon / Tachiyomi 中恢复即可！

---

## 🌐 支持的域名

脚本自动匹配以下官方主站及镜像域名：
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
