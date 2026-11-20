# 构境管线 JSON

一条管线定义为一个 JSON 文件，文件名为 `<id>.json`。桌面版将导入的定义保存在当前用户目录。原始结构由用户选择的数据根目录读取。

```json
{
  "id": "my_pipeline",
  "name": "我的结构筛选",
  "target": "填写自己的研究体系",
  "root": "D:/datasets/my-project",
  "steps": [
    {"id": "input", "title": "输入", "tool": "input", "globs": ["input/*.pdb"]},
    {"id": "review", "title": "复核", "tool": "review", "globs": ["models/*_model_*.cif"],
     "starGlobs": ["models/candidate_001_model_*.cif"], "note": "填写实际的筛选规则"}
  ]
}
```

以上是格式示例；路径和文件名需要替换为自己的内容。软件内置的 Aurora 演示完全由程序生成，没有真实科研输入。

- `id` 必填，1–64 个英文字母、数字、下划线或连字符，与定义文件名一致。
- `name` 必填，为管线显示名；`target` 为可选体系描述。
- `root` 必填，为本机可访问的绝对路径。所有结构路径相对它解析。
- `steps` 为有序步骤数组，每步具有唯一 `id` 和 `title`。
- 每步可提供 `tool`、`tag`、`round`、`desc`、`cmd`、`note`、`state`（done/now/wait）。
- `files` 为显式文件列表，元素包含 `name` 和 `path`。`globs` 为相对根目录的通配符列表。
- `*` 匹配一层文件名，`**` 跨目录；文件在当前目录时使用 `*.pdb`。
- `starGlobs` 控制初始星标。星标是用户选择的标记，不自动等同于科研达标。
- `groupBy` 可为 `none`、`candidate`、`parent` 或 `dir:N`。含 `_model_N` 的模型名默认按候选分组。
- 步骤或文件的 `lineage` 可包含 `candidateId`、`candidateName`、`parentId`、`parentName`、`modelIndex`、`role`、`artifactKind`、`assessmentSource`。文件级字段覆盖步骤默认值。
- `role` 可为 candidate、variant、parent、parent_control、reference；`artifactKind` 可为 design、mpnn_backbone、prediction、aligned、reference、preview。
- 结构路径不能是绝对路径，不能通过 `..` 越出根目录。

用户便签保存在数据根目录的 `.pipeline_notes.json`；界面会保留本机未同步草稿。定义文件、便签和原始结构各自独立。
