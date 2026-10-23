# sidecar-verify 中文说明

在部署静态网站前，检查 `.gz` / `.br` 解压后的内容是否与原文件一致。
即使修改时间和文件大小相同，也通过流式长度与 SHA-256 比较发现过期压缩副本。
需要 Node.js 22+，没有运行时第三方依赖。完整规则见 [英文 README](README.md)。

```console
npm install --global .
node examples/demo.js
sidecar-verify path/to/dist --require gzip --require brotli --json
```

请在预渲染、配置注入等所有构建步骤之后检查最终产物。工具只读，不会修复或删除文件。
默认检查已有的压缩副本；`--require` 额外要求常见 Web 文件存在指定编码副本。
可以重复 `--extension .html --extension .js` 调整要求的扩展名。

- 退出码 0：存在匹配对且全部通过；1：存在问题（包括未找到匹配对）；2：输入或参数错误。
- 默认每个原文件、压缩文件和解压数据上限 256 MiB，目录项上限 100,000，可通过参数调整。
- 支持 gzip / Brotli；损坏、孤立、缺失、过期、解压超限及忽略的尾部数据都会报告。
- 报告包含相对文件名；不会输出内容或内容摘要。检查前应停止其他构建写入。
- 不验证服务器响应头、CDN 或缓存配置，不适用于仅保存压缩文件的部署。
- 源码中的 CI 只是检查与构建，不会自动提交代码。

`npm test` 运行自动测试。`npm uninstall --global sidecar-verify` 卸载；自定义安装前缀需在卸载时使用相同前缀。
演示和测试会清理自己的临时文件。MIT 许可证，当前版本 0.1.0。
