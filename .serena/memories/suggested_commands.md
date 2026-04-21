# GitNexus 常用命令

## npm 脚本 (项目根目录)
```bash
npm run format        # 格式化代码
npm run format:check  # 检查格式
npm run lint          # ESLint 检查
npm run lint:fix      # 自动修复 lint 问题
```

## TypeScript
```bash
npx tsc --noEmit      # 类型检查
```

## GitNexus CLI
```bash
npx gitnexus analyze              # 分析当前仓库
npx gitnexus analyze --embeddings # 保留 embeddings
npx gitnexus status               # 查看索引状态
npx gitnexus clean                # 清理索引
npx gitnexus serve                # 启动 API 服务器
```

## 测试
```bash
npm test                  # 运行测试 (需确认脚本存在)
cd gitnexus && npm test   # 在包目录运行测试
```

## Serena
```bash
serena start-mcp-server --context=claude-code --project-from-cwd
```
