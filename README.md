# Notion Create Page (GitHub Action)

在 Notion database 里创建一个 page:**自定义列(column)的值**,并把**本地文本 / 文件**作为 page 正文。基于官方 [`@notionhq/client`](https://github.com/makenotion/notion-sdk-js)。

## 准备

1. 在 <https://www.notion.so/profile/integrations> 创建 integration,拿到 token,存为仓库 secret `NOTION_TOKEN`。
2. 打开目标 database → `···` → **Connections** → 添加该 integration(否则会 404)。
3. 复制 database ID(URL 里 `?v=` 前面那段 32 位字符),存为 `NOTION_DATABASE_ID`。

## 用法

```yaml
- uses: actions/checkout@v4

- id: notion
  uses: ./                      # 发布后换成 your-name/notion-page-action@v1
  with:
    notion_token: ${{ secrets.NOTION_TOKEN }}
    database_id: ${{ secrets.NOTION_DATABASE_ID }}
    title: "Build #${{ github.run_number }}"      # 自动写入 title 列
    properties: |
      {
        "Status": "Done",
        "Tags": "ci,release",
        "Score": 3,
        "Date": "2026-10-27",
        "Done": true,
        "Repo": "${{ github.repository }}"
      }
    content_file: ./CHANGELOG.md   # 或者用 content: 直接传文本

- run: echo "${{ steps.notion.outputs.page_url }}"
```

## Inputs

| 名称 | 必填 | 说明 |
|---|---|---|
| `notion_token` | ✅ | Integration token |
| `database_id` | ✅ | 目标 database ID |
| `title` |  | title 列的快捷写法(自动找到 title 列) |
| `properties` |  | JSON 对象:`{"列名": 值}`,**按 database 的列类型自动转换**,列名大小写不敏感 |
| `content` |  | 直接传入的文本,作为 page 正文 |
| `content_file` |  | 本地文件路径;`content` 为空时读取 |
| `content_format` |  | `markdown`(默认)或 `plain` |

## Outputs

`page_id`、`page_url`

## 支持的列类型与取值

| 列类型 | 写法 |
|---|---|
| title / rich_text / url / email / phone_number | 字符串 |
| number | `3` 或 `"3"` |
| select / status | 选项名 `"Done"` |
| multi_select | `"a,b"` 或 `["a","b"]` |
| date | `"2026-10-27"`、`"2026-10-27/2026-10-30"`(范围)、或 `{"start":..,"end":..,"time_zone":..}` |
| checkbox | `true` / `"true"` |
| people | 用户 ID,`"id1,id2"` |
| relation | 关联 page ID,`"id1,id2"` |
| files | 外链 URL,`"url1,url2"` |

formula / rollup / created_time 等只读列不能写入,传了会报错。传入不存在的列名时,报错信息会列出所有可用列。

## 正文(`markdown` 格式)支持

`# ## ###` 标题、`- ` 无序列表、`1. ` 有序列表、`- [ ]` / `- [x]` 待办、`> ` 引用、`---` 分割线、
` ```lang ` 代码块(语言自动映射,未知语言回退为 plain text),其余每行为一个段落。
行内格式(粗体、链接等)暂不解析,按纯文本写入。

长文本自动处理:单个文本超 2000 字符会拆分,超过 100 个 block 会分批追加。

## 开发

```bash
npm install
npm run build        # 用 ncc 打包到 dist/index.js
```

`dist/` **必须提交**到仓库,GitHub 直接运行 `dist/index.js`,不会安装依赖。

> 使用 SDK v2(Notion API `2022-06-28`)。如需适配新版 data source API(`2025-09-03`),
> 升级到 SDK v5,并把 `databases.retrieve` / `pages.create` 的 parent 改为 `data_source_id`。
