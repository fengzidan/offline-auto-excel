# Auto Excel

离线桌面应用（Tauri 2 + React + TypeScript）：编排 Excel 处理步骤，执行生成结果，导出可换源重算的公式模板。

文档见上级目录：

- [项目总览](../README.md)
- [需求说明书](../docs/requirements.md)
- [流程说明](../docs/process.md)
- [MVP 验收](../docs/mvp-acceptance.md)

## 开发

前置：Node.js、Rust（含 cargo）、平台对应的 Tauri 系统依赖。

```bash
cd auto-excel
npm install
npm run tauri dev
```

打包：

```bash
npm run tauri build
```

## 功能（MVP）

- 配置源目录 / 输出目录，刷新识别 Excel（一文件一 sheet）
- 拖拽编排步骤：筛选、透视、关联相减、并排拼版
- 步骤小样本预览；表头缺失时报错，可在步骤内改列名
- 方案 JSON 保存 / 加载
- 执行写出结果 xlsx；导出 FILTER / UNIQUE / SUMIF / XLOOKUP 公式模板

## 目录

```text
src/           前端 UI
src-tauri/     Rust 执行引擎与 xlsx 读写
```
