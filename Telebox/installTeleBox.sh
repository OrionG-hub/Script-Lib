#!/usr/bin/env bash
# TeleBox 实例管理安装脚本
# 适用于 Debian / Ubuntu 体系

set -euo pipefail

readonly NODE_VERSION="24"
readonly GITHUB_REPO="${TELEBOX_REPO:-https://github.com/TeleBoxDev/TeleBox.git}"
readonly GITHUB_BRANCH="${TELEBOX_BRANCH:-main}"
readonly DEFAULT_INSTANCE="telebox"
readonly INSTANCE_BASE_DIR="${TELEBOX_BASE_DIR:-$HOME/telebox-instances}"

readonly C_RED='\033[0;31m'
readonly C_GREEN='\033[0;32m'
readonly C_YELLOW='\033[1;33m'
readonly C_BLUE='\033[0;34m'
readonly C_NC='\033[0m'

INSTANCE_NAME=""
APP_DIR=""
PM2_NAME=""
declare -A PM2_STATES=()
PM2_QUERY_STATE="not-queried"

log_info()  { echo -e "${C_GREEN}[INFO] $1${C_NC}"; }
log_warn()  { echo -e "${C_YELLOW}[WARN] $1${C_NC}"; }
log_err()   { echo -e "${C_RED}[ERROR] $1${C_NC}"; }
log_step()  { echo -e "\n${C_BLUE}==== $1 ====${C_NC}"; }

handle_error() {
    local line_no=$1
    local failed_command=$2
    log_err "脚本执行中止！"
    log_err "故障位置: 第 ${line_no} 行"
    log_err "失败命令: ${failed_command}"
    exit 1
}

trap 'handle_error ${LINENO} "${BASH_COMMAND}"' ERR

as_root() {
    if [[ $EUID -eq 0 ]]; then
        "$@"
    else
        sudo "$@"
    fi
}

confirm() {
    local prompt=$1
    local default=${2:-N}
    local suffix="[y/N]"
    local reply

    if [[ "$default" =~ ^[Yy]$ ]]; then
        suffix="[Y/n]"
    fi

    read -r -p "$prompt $suffix: " reply
    if [[ -z "$reply" ]]; then
        reply=$default
    fi

    [[ "$reply" =~ ^[Yy]$ ]]
}

validate_instance_name() {
    local name=$1
    [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$ ]]
}

set_instance() {
    local name=${1:-$DEFAULT_INSTANCE}

    if ! validate_instance_name "$name"; then
        log_err "实例名称非法：$name"
        log_err "仅允许字母、数字、下划线和短横线，且必须以字母或数字开头。"
        exit 1
    fi

    INSTANCE_NAME="$name"
    if [[ "$INSTANCE_NAME" == "$DEFAULT_INSTANCE" ]]; then
        APP_DIR="$HOME/telebox"
        PM2_NAME="telebox"
    elif [[ "$INSTANCE_NAME" == telebox-* ]]; then
        APP_DIR="$INSTANCE_BASE_DIR/$INSTANCE_NAME"
        PM2_NAME="$INSTANCE_NAME"
    else
        APP_DIR="$INSTANCE_BASE_DIR/$INSTANCE_NAME"
        PM2_NAME="telebox-$INSTANCE_NAME"
    fi
}

require_debian_like() {
    if [[ ! -f /etc/debian_version ]]; then
        log_err "当前脚本只自动处理 Debian / Ubuntu。"
        exit 1
    fi
}

require_sudo_if_needed() {
    if [[ $EUID -ne 0 ]] && ! command -v sudo >/dev/null 2>&1; then
        log_err "当前用户不是 root，且系统未安装 sudo。"
        exit 1
    fi
}

pkg_installed() {
    dpkg -s "$1" >/dev/null 2>&1
}

install_system_deps() {
    log_step "系统依赖核对与安装"
    require_debian_like
    require_sudo_if_needed

    local packages=(
        ca-certificates
        curl
        git
        build-essential
        python3
        ffmpeg
        pkg-config
        libcairo2-dev
        libpango1.0-dev
        libjpeg-dev
        libgif-dev
        librsvg2-dev
    )
    local missing=()
    local pkg

    for pkg in "${packages[@]}"; do
        if ! pkg_installed "$pkg"; then
            missing+=("$pkg")
        fi
    done

    if ((${#missing[@]} > 0)); then
        log_info "正在补全基础和原生模块构建依赖..."
        as_root apt-get update -y
        as_root apt-get install -y "${missing[@]}"
    else
        log_info "系统依赖已就绪，跳过安装。"
    fi

    local need_install_node=true
    if command -v node >/dev/null 2>&1; then
        local current_node_ver
        current_node_ver=$(node -v | sed -E 's/^v([0-9]+).*/\1/')
        if [[ "$current_node_ver" == "$NODE_VERSION" ]]; then
            log_info "检测到 Node.js v${NODE_VERSION}.x 已安装，跳过覆盖安装。"
            need_install_node=false
        else
            log_warn "检测到 Node.js v${current_node_ver}.x，上游 TeleBox 当前要求 v${NODE_VERSION}.x。"
        fi
    fi

    if $need_install_node; then
        log_info "开始安装 Node.js ${NODE_VERSION}.x 环境..."
        curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | as_root bash -
        as_root apt-get install -y nodejs
    fi
}

ensure_pm2() {
    if ! command -v pm2 >/dev/null 2>&1; then
        log_info "全局安装 PM2 进程管理器..."
        as_root npm install -g pm2
    fi
}

load_pm2_states() {
    PM2_STATES=()
    if ! command -v pm2 >/dev/null 2>&1; then
        PM2_QUERY_STATE="pm2-not-installed"
        return
    fi

    local states name state
    if ! states=$(pm2 jlist 2>/dev/null | node -e '
const fs = require("node:fs");
const entries = JSON.parse(fs.readFileSync(0, "utf8"));
const states = new Map();
for (const entry of entries) {
    if (typeof entry.name !== "string" || /[\t\r\n]/.test(entry.name)) continue;
    const running = Number.isInteger(entry.pid) && entry.pid > 0;
    if (running || !states.has(entry.name)) {
        states.set(entry.name, running ? `running(pid:${entry.pid})` : "stopped");
    }
}
for (const [name, state] of states) console.log(`${name}\t${state}`);
'); then
        PM2_QUERY_STATE="unavailable"
        return
    fi

    while IFS=$'\t' read -r name state; do
        [[ -n "$name" ]] && PM2_STATES["$name"]=$state
    done <<< "$states"
    PM2_QUERY_STATE="ready"
}

pm2_state() {
    local name=$1
    if [[ "${2:-}" != "snapshot" ]]; then
        load_pm2_states
    fi
    if [[ "$PM2_QUERY_STATE" == "ready" ]]; then
        echo "${PM2_STATES[$name]:-not-registered}"
    else
        echo "$PM2_QUERY_STATE"
    fi
}

repo_status() {
    if [[ ! -d "$APP_DIR" ]]; then
        echo "missing"
    elif [[ -d "$APP_DIR/.git" ]]; then
        echo "git"
    else
        echo "non-git-dir"
    fi
}

instance_exists() {
    local name=$1
    set_instance "$name"
    [[ -d "$APP_DIR" ]] || { command -v pm2 >/dev/null 2>&1 && pm2 describe "$PM2_NAME" >/dev/null 2>&1; }
}

generate_instance_name() {
    local index=1
    local candidate

    if ! instance_exists "$DEFAULT_INSTANCE"; then
        echo "$DEFAULT_INSTANCE"
        return
    fi

    while true; do
        candidate=$(printf "telebox-%02d" "$index")
        if ! instance_exists "$candidate"; then
            echo "$candidate"
            return
        fi
        ((index++))
    done
}

print_instance_row() {
    local name=$1
    set_instance "$name"
    printf "%-18s %-42s %-24s %s\n" "$INSTANCE_NAME" "$APP_DIR" "$(repo_status)" "$(pm2_state "$PM2_NAME" snapshot)"
}

list_instances() {
    load_pm2_states
    log_step "本机 TeleBox 状态"
    printf "%-18s %-42s %-24s %s\n" "INSTANCE" "DIR" "REPO" "PM2"
    printf "%-18s %-42s %-24s %s\n" "--------" "---" "----" "---"

    print_instance_row "$DEFAULT_INSTANCE"

    if [[ -d "$INSTANCE_BASE_DIR" ]]; then
        local dir
        while IFS= read -r dir; do
            print_instance_row "$(basename "$dir")"
        done < <(find "$INSTANCE_BASE_DIR" -mindepth 1 -maxdepth 1 -type d | sort)
    fi
}

select_instance_interactive() {
    local default_name=${1:-$DEFAULT_INSTANCE}
    local input

    read -r -p "请输入实例名称 [$default_name]: " input
    set_instance "${input:-$default_name}"
}

select_install_instance_interactive() {
    local generated
    local input

    generated=$(generate_instance_name)
    read -r -p "请输入实例名称，留空自动使用 [$generated]: " input
    set_instance "${input:-$generated}"
}

set_install_instance() {
    local name=${1:-}

    if [[ -z "$name" ]]; then
        name=$(generate_instance_name)
        log_info "未指定实例名称，自动使用：$name"
    fi

    set_instance "$name"
}

ensure_app_repo() {
    log_step "代码拉取与更新"
    mkdir -p "$(dirname "$APP_DIR")"

    if [[ ! -d "$APP_DIR" ]]; then
        log_info "克隆 TeleBox ${GITHUB_BRANCH} 到 $APP_DIR"
        git clone --depth 1 --branch "$GITHUB_BRANCH" "$GITHUB_REPO" "$APP_DIR"
        return
    fi

    if [[ ! -d "$APP_DIR/.git" ]]; then
        log_err "$APP_DIR 已存在，但不是 Git 仓库。"
        log_err "请换一个实例名称，或手动处理该目录。"
        exit 1
    fi

    log_info "检测到已有实例目录，尝试快进更新..."
    git -C "$APP_DIR" remote set-url origin "$GITHUB_REPO"
    git -C "$APP_DIR" fetch origin "$GITHUB_BRANCH" --tags

    if ! git -C "$APP_DIR" merge --ff-only "origin/$GITHUB_BRANCH"; then
        log_warn "本地代码无法快进到 origin/$GITHUB_BRANCH，已跳过自动更新。"
        log_warn "如果你改过 TeleBox 源码，请先自行合并；插件和配置不受影响。"
    fi
}

node_deps_fingerprint() {
    local npm_version
    npm_version=$(npm --version) || return $?
    node - "$npm_version" <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const hash = crypto.createHash("sha256");
hash.update(JSON.stringify(["v1", process.version, process.versions.modules, process.platform, process.arch, process.argv[2]]));
const userConfig = process.env.npm_config_userconfig || process.env.NPM_CONFIG_USERCONFIG || path.join(os.homedir(), ".npmrc");
for (const file of ["package.json", "package-lock.json", "npm-shrinkwrap.json", ".npmrc", userConfig]) {
    hash.update(JSON.stringify([file, fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null]));
}
for (const key of Object.keys(process.env).filter((key) => /^npm_config_/i.test(key) || key === "NODE_ENV").sort()) {
    hash.update(JSON.stringify([key, process.env[key]]));
}
console.log(hash.digest("hex"));
NODE
}

install_node_deps() {
    local force=${1:-false}
    log_step "项目依赖安装"
    cd "$APP_DIR"

    local fingerprint stamp="node_modules/.telebox-deps-fingerprint"
    fingerprint=$(node_deps_fingerprint) || return $?
    if [[ "$force" != "true" && -f "$stamp" && "$(< "$stamp")" == "$fingerprint" ]]; then
        log_info "依赖和运行环境未变化，跳过安装。"
        return
    fi

    stop_instance
    rm -f "$stamp"
    if [[ "$force" == "true" ]]; then
        rm -rf node_modules
    fi

    if [[ -f package-lock.json || -f npm-shrinkwrap.json ]]; then
        log_info "检测到依赖锁文件，使用 npm ci 进行可复现安装..."
        npm ci --prefer-offline --no-audit || return $?
    else
        log_warn "未检测到 package-lock.json，回退到 npm install。"
        npm install --prefer-offline --no-audit || return $?
    fi
    fingerprint=$(node_deps_fingerprint) || return $?
    mkdir -p node_modules
    printf '%s\n' "$fingerprint" > "$stamp"
}

refresh_node_deps() {
    log_step "重新拉取项目依赖：$INSTANCE_NAME"
    if [[ ! -d "$APP_DIR" ]]; then
        log_err "实例目录不存在：$APP_DIR"
        exit 1
    fi

    install_system_deps
    ensure_app_repo

    cd "$APP_DIR"
    log_info "校验 npm 缓存并强制重装依赖..."
    npm cache verify

    install_node_deps true
    start_instance
}

config_has_session() {
    local config_file="$APP_DIR/config.json"
    [[ -f "$config_file" ]] || return 1

    node - "$config_file" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
try {
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  process.exit(config.session ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
}

clear_login_config() {
    local config_file="$APP_DIR/config.json"
    local backup_file="$APP_DIR/config.json.bak.$(date +%Y%m%d%H%M%S)"

    if [[ ! -f "$config_file" ]]; then
        log_warn "未找到 config.json，下一次启动会重新询问 API_ID / API_HASH。"
        return
    fi

    cp "$config_file" "$backup_file"
    log_info "已备份当前配置到 $backup_file"

    node - "$config_file" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const config = JSON.parse(fs.readFileSync(file, "utf8"));
delete config.session;
delete config.api_id;
delete config.api_hash;
delete config.apiId;
delete config.apiHash;
delete config.API_ID;
delete config.API_HASH;
fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
NODE
    log_info "已清除 Telegram session、API_ID 和 API_HASH。"
}

interactive_login() {
    log_step "TeleBox 交互式登录"
    cd "$APP_DIR"

    log_warn "即将进入 TeleBox 登录流程。"
    log_warn "如需切换账号，请确认当前实例已清除旧 API_ID / API_HASH / session。"
    log_warn "看到类似 '[INFO] - [Signed in successfully as xxx]' 后，按 CTRL+C 返回脚本。"
    echo -e "${C_GREEN}按 <回车键> 开始登录...${C_NC}"
    read -r

    set +e
    trap - ERR
    trap 'log_info "\n捕获到中断信号，登录阶段结束。"' SIGINT

    npm start || true

    trap - SIGINT
    trap 'handle_error ${LINENO} "${BASH_COMMAND}"' ERR
    set -e

    sleep 1
}

write_pm2_wrapper() {
    local wrapper_file="$APP_DIR/ecosystem.local.config.js"

    cat > "$wrapper_file" <<EOF
module.exports = {
  apps: [{
    name: "$PM2_NAME",
    script: "npm",
    args: "start",
    cwd: __dirname,
    error_file: "./logs/error.log",
    out_file: "./logs/out.log",
    merge_logs: true,
    time: true,
    autorestart: true,
    max_restarts: 10,
    min_uptime: "10s",
    restart_delay: 4000,
    env: {
      NODE_ENV: "production"
    },
    env_production: {
      NODE_ENV: "production"
    }
  }]
}
EOF
}

cleanup_legacy_pm2_entries() {
    if ! command -v pm2 >/dev/null 2>&1; then
        return
    fi

    local legacy_name
    for legacy_name in ecosystem.local ecosystem.local.config; do
        if [[ "$legacy_name" != "$PM2_NAME" ]] && pm2 describe "$legacy_name" >/dev/null 2>&1; then
            log_warn "清理旧的误启动 PM2 进程：$legacy_name"
            pm2 delete "$legacy_name" || true
        fi
    done
}

setup_pm2_startup() {
    local node_path
    local pm2_path

    node_path=$(dirname "$(command -v node)")
    pm2_path=$(command -v pm2)

    if as_root env PATH="$PATH:$node_path" "$pm2_path" startup systemd -u "$USER" --hp "$HOME" >/dev/null 2>&1; then
        log_info "PM2 开机自启配置成功。"
    else
        log_warn "自动注册 PM2 开机自启失败，可安装完成后手动运行: pm2 startup"
    fi
}

start_instance() {
    log_step "启动实例：$INSTANCE_NAME"
    if [[ ! -d "$APP_DIR" ]]; then
        log_err "实例目录不存在：$APP_DIR"
        exit 1
    fi

    ensure_pm2
    mkdir -p "$APP_DIR/logs"
    write_pm2_wrapper
    cleanup_legacy_pm2_entries

    cd "$APP_DIR"
    pm2 startOrReload ecosystem.local.config.js --env production
    pm2 save
    setup_pm2_startup
}

stop_instance() {
    log_step "停止实例：$INSTANCE_NAME"
    if command -v pm2 >/dev/null 2>&1 && pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
        pm2 stop "$PM2_NAME" || true
        pm2 save || true
    else
        log_warn "PM2 中未注册该实例：$PM2_NAME"
    fi
}

delete_pm2_instance() {
    if command -v pm2 >/dev/null 2>&1; then
        pm2 delete "$PM2_NAME" 2>/dev/null || true
        pm2 save 2>/dev/null || true
    fi
}

install_or_update_instance() {
    log_step "准备实例：$INSTANCE_NAME"
    log_info "实例目录: $APP_DIR"
    log_info "PM2 名称: $PM2_NAME"

    install_system_deps
    ensure_app_repo
    install_node_deps

    if config_has_session; then
        log_info "检测到已有 Telegram session，跳过登录。"
    else
        log_warn "未检测到可用 Telegram session，需要先完成登录。"
        interactive_login
    fi

    start_instance
}

switch_login() {
    log_step "切换 Telegram 登录账号：$INSTANCE_NAME"
    if [[ ! -d "$APP_DIR" ]]; then
        log_err "实例目录不存在：$APP_DIR"
        exit 1
    fi

    if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
        install_system_deps
    fi
    install_node_deps
    stop_instance
    clear_login_config
    interactive_login
    start_instance
}

show_status() {
    log_step "实例状态：$INSTANCE_NAME"
    log_info "实例目录: $APP_DIR"
    log_info "PM2 名称: $PM2_NAME"
    log_info "仓库状态: $(repo_status)"
    log_info "PM2 状态: $(pm2_state "$PM2_NAME")"

    if command -v pm2 >/dev/null 2>&1; then
        pm2 status "$PM2_NAME" || true
    fi
}

remove_instance() {
    log_step "删除实例：$INSTANCE_NAME"
    log_warn "这会删除 PM2 进程和实例目录：$APP_DIR"
    log_warn "config.json 中的 API 配置和 Telegram session 也会被删除。"

    if ! confirm "确认删除该实例？" "N"; then
        log_warn "已取消删除。"
        return
    fi

    delete_pm2_instance
    rm -rf "$APP_DIR"
    log_info "实例已删除。"
}

show_logs() {
    if ! command -v pm2 >/dev/null 2>&1; then
        log_err "PM2 未安装，无法查看日志。"
        exit 1
    fi

    pm2 logs "$PM2_NAME" --lines 80
}

usage() {
    cat <<EOF
用法:
  $0                         进入交互菜单
  $0 list                    列出本机实例
  $0 install [instance]      安装或更新实例；留空时自动使用 telebox / telebox-01 / telebox-02...
  $0 login [instance]        切换该实例的 Telegram 登录账号
  $0 start [instance]        启动或重载实例
  $0 stop [instance]         停止实例
  $0 restart [instance]      重启实例
  $0 deps [instance]         重新拉取项目依赖并重启实例
  $0 status [instance]       查看实例状态
  $0 logs [instance]         查看实例日志
  $0 remove [instance]       删除实例目录和 PM2 进程
  $0 reset                   删除所有实例后重新安装 telebox

实例说明:
  telebox 使用 $HOME/telebox 和 PM2 名称 telebox
  telebox-01 这类实例使用 $INSTANCE_BASE_DIR/<instance> 和同名 PM2 进程
  其他自定义实例继续使用 PM2 名称 telebox-<instance>

环境变量:
  TELEBOX_REPO=$GITHUB_REPO
  TELEBOX_BRANCH=$GITHUB_BRANCH
  TELEBOX_BASE_DIR=$INSTANCE_BASE_DIR
EOF
}

list_all_instance_names() {
    echo "$DEFAULT_INSTANCE"

    if [[ -d "$INSTANCE_BASE_DIR" ]]; then
        local dir
        while IFS= read -r dir; do
            basename "$dir"
        done < <(find "$INSTANCE_BASE_DIR" -mindepth 1 -maxdepth 1 -type d | sort)
    fi
}

reset_all_and_install() {
    log_step "清空全部 TeleBox 实例并重新安装"
    log_warn "这会删除以下内容："
    log_warn "1. 默认实例目录：$HOME/telebox"
    log_warn "2. 多实例目录：$INSTANCE_BASE_DIR"
    log_warn "3. 已注册的 TeleBox PM2 进程"
    log_warn "config.json、Telegram session、日志都会被删除。"

    if ! confirm "确认全部清空并重新安装？" "N"; then
        log_warn "已取消。"
        return
    fi

    local name
    while IFS= read -r name; do
        set_instance "$name"
        delete_pm2_instance
    done < <(list_all_instance_names)

    cd "$HOME"
    rm -rf "$HOME/telebox" "$INSTANCE_BASE_DIR"
    set_instance "$DEFAULT_INSTANCE"
    install_or_update_instance
}

menu() {
    while true; do
        list_instances
        echo
        echo "1) 安装/新增实例"
        echo "2) 切换 Telegram 登录账号"
        echo "3) 查看实例状态"
        echo "4) 查看实例日志"
        echo "5) 删除单个实例"
        echo "6) 全部清空并重新安装"
        echo "7) 重新拉取项目依赖"
        echo "0) 退出"
        echo

        local choice
        read -r -p "请选择操作: " choice

        case "$choice" in
            1)
                select_install_instance_interactive
                install_or_update_instance
                ;;
            2)
                select_instance_interactive
                switch_login
                ;;
            3)
                select_instance_interactive
                show_status
                ;;
            4)
                select_instance_interactive
                show_logs
                ;;
            5)
                select_instance_interactive
                remove_instance
                ;;
            6)
                reset_all_and_install
                ;;
            7)
                select_instance_interactive
                refresh_node_deps
                ;;
            0)
                exit 0
                ;;
            *)
                log_warn "无效选项。"
                ;;
        esac

        echo
        local next_action
        read -r -p "按回车键返回菜单，输入 0 退出: " next_action
        if [[ "$next_action" == "0" ]]; then
            exit 0
        fi
    done
}

main() {
    local command=${1:-menu}
    local instance=${2:-}

    case "$command" in
        menu)
            menu
            ;;
        list)
            list_instances
            ;;
        install|update)
            set_install_instance "$instance"
            install_or_update_instance
            ;;
        login|switch-login)
            set_instance "${instance:-$DEFAULT_INSTANCE}"
            switch_login
            ;;
        start)
            set_instance "${instance:-$DEFAULT_INSTANCE}"
            start_instance
            ;;
        stop)
            set_instance "${instance:-$DEFAULT_INSTANCE}"
            stop_instance
            ;;
        restart)
            set_instance "${instance:-$DEFAULT_INSTANCE}"
            stop_instance
            start_instance
            ;;
        deps|refresh-deps|reinstall-deps)
            set_instance "${instance:-$DEFAULT_INSTANCE}"
            refresh_node_deps
            ;;
        status)
            set_instance "${instance:-$DEFAULT_INSTANCE}"
            show_status
            ;;
        logs)
            set_instance "${instance:-$DEFAULT_INSTANCE}"
            show_logs
            ;;
        remove|uninstall)
            set_instance "${instance:-$DEFAULT_INSTANCE}"
            remove_instance
            ;;
        reset|reset-all|reinstall)
            reset_all_and_install
            ;;
        help|-h|--help)
            usage
            ;;
        *)
            log_err "未知命令：$command"
            usage
            exit 1
            ;;
    esac
}

main "$@"
