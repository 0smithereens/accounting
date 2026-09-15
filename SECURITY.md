# 安全说明

## 这个项目处理的是什么数据

会计自动化记账系统读取**真实的财务单据**：银行流水、工资表、发票台账、合同。
这些文件里含有银行账号、身份证号、薪资、税号、商业往来关系等敏感信息。

因此本项目的安全模型是**「数据不出本机」**，这不是可选项，是设计前提。

---

## 安全设计

### 1. 零网络请求

核心记账流程（`src/cli.ts`、`src/pipeline.ts` 及其依赖）**不发起任何网络请求**。
没有遥测、没有上报、没有云端 API 调用、没有大模型调用。

你可以自己验证：

```bash
# 1. 后端源码里没有任何网络调用
grep -rn "fetch(\|http.request\|https.request\|axios\|node-fetch" src/ --include=*.ts
#    期望：没有任何输出

# 2. 核心层没有 import 任何网络模块
grep -rn "from 'node:\(http\|https\|net\|dns\|tls\)'" src/core src/io src/extract src/ledger src/export
#    期望：没有任何输出

# 3. 运行时依赖只有三个，都是本地处理库
node -e "console.log(Object.keys(require('./package.json').dependencies))"
#    期望：[ 'exceljs', 'mammoth', 'yaml' ]
```

唯一的网络相关代码是 `src/web/public/app.js` 里的两处 `fetch()`，
它们调用的是 **你自己的本机服务**（`/api/config` 与 `/api/process`），不涉及任何外部地址。
`src/web/server.ts` 启动的 HTTP 服务**只监听 `127.0.0.1`**（回环地址），
局域网内其他机器无法访问。

### 2. Web 界面默认只绑定本机

```
node src/web/server.ts          # 默认 127.0.0.1:8787
```

**不要改成 `--host 0.0.0.0`**，除非你清楚风险：
那会让同一网络内的任何人都能访问你的账务数据和上传的文件。
Web 界面没有做身份认证，它是给单机单人使用设计的。

### 3. 上传文件的路径穿越防护

Web 界面上传的文件名会经过 `safeFileName()` 处理，
去掉路径部分和危险字符，防止 `../../` 之类的路径穿越写入。

### 4. 静态文件访问限制

`serveStatic()` 会校验解析后的绝对路径必须位于 `src/web/public/` 之内，
防止通过构造 URL 读取任意文件。

---

## ⚠️ 已知风险：`out/` 目录

这是**最需要注意的一点**。

### 风险 1：Web 界面上传的原始文件会落盘

Web 界面上传的文件会临时写入 `out/web-runs/<运行id>/`，
服务正常退出时会删除，但如果进程被强杀（任务管理器结束进程），这些文件会残留。

**这些是你真实的账务文件。**

处理建议：定期清理

```bash
# 确认里面没有你需要的东西后
rm -rf out/web-runs        # Linux/macOS
Remove-Item out\web-runs -Recurse -Force   # Windows PowerShell
```

### 风险 2：浏览器自动化工具可能把配置目录写进 `out/`

如果你或某个自动化脚本把 `out/` 当作临时工作目录，
浏览器的用户配置目录可能被写进去，里面包含：

- `Login Data` — 保存的网站密码
- `Network/Cookies` — 登录会话
- `Nigori.bin` — 浏览器同步加密密钥
- `Vpn Tokens`、`trusted_vault.pb` — 各类令牌

**这类目录一旦被提交到公开仓库，等同于把账号交出去。**
GitHub 上存在专门扫描密钥的自动化程序，推送后通常在几分钟内就会被抓取利用。

好消息是 `.gitignore` 已经排除了 `out/` 和 `*-profile/`，
CI 里也有一道 `guard` 任务检查敏感路径是否被跟踪。

**但请不要依赖这两道防线。** 提交前请自己看一眼 `git status`。

---

## 提交代码前的自查清单

```bash
# 1. 看这次会提交什么
git status
git diff --cached --name-only

# 2. 确认没有 out/、profile 目录、真实单据
git ls-files | grep -E "^(out/|.*-profile/|node_modules/)" && echo "⚠️ 有问题！"

# 3. 搜索疑似真实身份信息
git diff --cached | grep -E "[0-9]{17}[0-9Xx]|[0-9]{16,19}|1[3-9][0-9]{9}"
```

如果你**不小心提交并推送了**敏感数据，请立刻：

1. **先改密码 / 吊销凭据**——不要指望删掉提交就能补救，密钥一旦公开即视为已泄露
2. 用 `git filter-repo` 或 BFG 清理历史
3. 强制推送后，联系 GitHub Support 清理缓存

删除提交是**没用的**，GitHub 的历史记录和 fork 都会保留。

---

## 报告安全漏洞

如果你发现了安全问题，请**不要直接开公开 Issue**。

请通过 GitHub 的
[Private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
功能私下报告，或发邮件给仓库维护者（见 GitHub 个人主页）。

请包含：

- 问题描述与影响范围
- 复现步骤
- 受影响的版本/提交
- 你建议的修复方式（如果有）

我会尽快回复。请给我合理的时间在公开披露前修复。

---

## 不在安全范围内的内容

以下属于**已声明的设计限制**，不是漏洞：

| 情况 | 说明 |
| --- | --- |
| 生成的凭证可能有错 | 这是辅助工具，产出的是草稿，必须人工复核。见 README「已知限制」 |
| Web 界面没有登录认证 | 它是单机单用户工具，靠绑定 `127.0.0.1` 隔离，不面向多用户场景 |
| 上传文件大小上限 60MB | 刻意设置，防止内存耗尽 |
| `.xls` / `.doc` 转换脚本调用本机 Excel | 需要本机装 Excel，属于已知依赖 |
