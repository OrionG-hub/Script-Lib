# TeleBox Scripts

TeleBox 部署和管理脚本集合，提供直接安装、生产级 PM2 部署，以及 Docker Compose 菜单式管理三种入口。

## 文件

| 文件 | 说明 | 推荐场景 |
| --- | --- | --- |
| `telebox.sh` | 传统单实例全新安装入口，会清理旧目录；本次保持原行为 | 需要清空后重新安装时使用 |
| `installTeleBox.sh` | 多实例 PM2 管理，支持安装/更新、切换账号、依赖重装、状态和日志 | 已有服务维护和多实例部署 |
| `telebox-docker.sh` | Docker Compose 菜单式管理脚本，支持安装、卸载、启停、重装、日志、备份、恢复 | 希望容器化部署和管理时使用 |

## 直接部署

传统全新安装入口：

```bash
chmod +x telebox.sh
./telebox.sh
```

脚本会执行：

- 清理旧 TeleBox 进程和 `$HOME/telebox`。
- 安装基础依赖和 Node.js 20。
- 克隆 `https://github.com/TeleBoxDev/TeleBox.git`。
- 进入交互式 Telegram 登录流程。
- 生成 PM2 `ecosystem.config.js`。
- 启动 `telebox` 服务并尝试配置开机自启。

服务目录：

```text
$HOME/telebox
```

常用命令：

```bash
pm2 status telebox
pm2 logs telebox
pm2 restart telebox
pm2 stop telebox
pm2 delete telebox
```

## PM2 实例管理

```bash
chmod +x installTeleBox.sh
./installTeleBox.sh
```

无参数时进入菜单；也可直接指定操作：

```bash
./installTeleBox.sh install telebox
./installTeleBox.sh install telebox-01
./installTeleBox.sh login telebox
./installTeleBox.sh deps telebox
./installTeleBox.sh list
```

- `install`/`update`：更新代码，但依赖指纹未变化时跳过 npm 安装。只有需要重装时才先停止实例，避免运行中删除依赖。
- `login`：切换账号，不再顺便拉取新代码；复用已有 Node/npm，仅在工具缺失时安装系统依赖，项目依赖按同一指纹检查。
- `deps`：显式强制重装，保留校验 npm 缓存、清空 node_modules、重新安装和启动的行为。
- 指纹包含 package.json、锁文件、项目/用户 npm 配置、Node/npm 版本、平台架构及相关环境变量，保存在 `node_modules/.telebox-deps-fingerprint`。只有安装成功后才写入；首次使用新逻辑时会安装一次。
- 指纹不是完整依赖健康检查；手动删除或损坏部分 node_modules 后，请执行 `deps` 修复。改变未纳入指纹的系统库或全局 npm 配置后也应执行 `deps`。
- 实例列表每次只取一次 PM2 进程快照，再显示各实例状态；下次查询重新获取，不长期缓存。
- 此入口使用 Node.js 24；默认实例目录是 `$HOME/telebox`，其他实例位于 `$HOME/telebox-instances/<实例名称>`。普通安装/更新不会清空账号配置，`remove`/`reset` 才会删除数据。

## Docker Compose 部署

```bash
chmod +x telebox-docker.sh
sudo ./telebox-docker.sh
```

脚本启动后会进入菜单，支持：

- 安装 TeleBox
- 卸载 TeleBox
- 关闭、启动、重启 TeleBox
- 重装 TeleBox
- 查看日志
- 进入容器
- 查看容器信息
- 备份和恢复 TeleBox

默认数据目录：

```text
/root/Docker_Telebox/<容器名称>
```

默认临时 Compose 目录：

```text
/tmp/telebox-compose-<容器名称>
```

### 运行镜像与启动速度

首次新安装会在本机构建 `telebox-runtime:node20-v1`，预装系统依赖、Node.js 20 和 PM2；后续安装复用该镜像。保留 Docker 入口原来的 Node.js 20，不与 PM2 管理入口自动合并版本。

交互式初始化和后台服务使用同一镜像。新生成的后台命令只启动 `pm2-runtime`，不再每次启动都执行 apt、NodeSource 和全局 PM2 安装。交互阶段仍需获取原来的 TeleBox 安装脚本并完成登录，初始化失败时不会继续启动后台服务。

可单独准备或显式更新运行镜像，不创建或删除实例：

```bash
sudo ./telebox-docker.sh build-runtime
sudo env TELEBOX_REBUILD_IMAGE=1 ./telebox-docker.sh build-runtime
```

第二条命令重新拉取基础镜像并禁用构建缓存，用于主动更新运行环境；不会自动重建正在运行的容器。首次构建仍需要联网，缓存镜像也需要定期显式更新。

容器列表改为一次 Docker 查询返回所有名称和状态；单容器详情也合并读取状态和 ID。

### 现有容器迁移

更新管理脚本不会自动覆盖已有 Compose 配置或重建容器。要让现有实例使用新启动方式：

1. 备份数据和原 Compose 配置，确认 `/root/telebox/ecosystem.config.js` 已存在，应用兼容当前 Node.js 20 运行环境。
2. 执行 `build-runtime` 准备镜像。
3. 在原 Compose 服务中将 `image` 改为 `telebox-runtime:node20-v1`，删除旧的 `pull_policy: always` 和包含安装命令的 `command`，改成下面的启动命令；保留容器名称、数据卷及其他自定义设置。

```yaml
command: ["pm2-runtime", "/root/telebox/ecosystem.config.js"]
```

4. 使用原 Compose 文件执行 `up -d --force-recreate`，检查日志；失败时恢复原配置。迁移会短暂中断服务。

不要通过“卸载/重装”菜单迁移已有数据；这些操作可能删除数据目录。

## 运行环境

直接部署需要：

- Debian / Ubuntu
- `sudo`
- `curl`
- `git`
- `telebox.sh` 使用 Node.js 20，`installTeleBox.sh` 使用 Node.js 24，脚本会按各自流程检查或安装
- PM2，脚本会尝试安装

Docker 部署需要：

- root 权限
- Docker
- Docker Compose v1 或 Docker Compose Plugin

## 交互式登录

直接部署和 Docker 部署都需要首次登录 Telegram 账号。看到类似：

```text
You should now be connected.
```

再按 `Ctrl+C` 退出登录阶段，脚本会继续进入后台服务配置。

## 安全注意

- 这些脚本包含清理、重装、删除容器和删除数据目录的逻辑，执行前请确认目标路径。
- `telebox.sh` 会清理 `$HOME/telebox`；`installTeleBox.sh` 的删除/重置操作会删除对应实例数据。
- `telebox-docker.sh` 的卸载和重装功能可能删除 `/root/Docker_Telebox/<容器名称>` 下的数据。
- Telegram API ID、API Hash 和登录状态属于敏感信息，不要公开泄露。

## 排错

查看 PM2 日志：

```bash
pm2 logs telebox --lines 50
```

查看 Docker 日志：

```bash
sudo ./telebox-docker.sh
```

然后选择 `查看日志`。

如果服务无法开机自启，手动执行：

```bash
pm2 startup
pm2 save
```

## 本次优化验证

- 临时测试脚本 `/tmp/orion-optimizations.test.cjs` 共 18 项：17 项通过，真实 Docker 集成测试因未安装 Docker 跳过。
- 包含依赖指纹、失败重试、强制重装、登录流程和状态查询测试；使用无远端依赖的临时项目实际执行离线 npm 安装，Docker/PM2 调用使用替身验证。
- Shell 语法及 ShellCheck error 级检查通过；warning 级仍有原来的 `SC2155`，位于 `clear_login_config`，本次不改无关代码。
- 当前未安装 Docker、PM2、kcov，未完成真实镜像构建、Linux/PM2 服务集成或 Shell 覆盖率统计；上线前仍需验证安装脚本、镜像和应用依赖在目标服务器的兼容性。
