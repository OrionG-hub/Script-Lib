#!/bin/bash
# TeleBox 多实例管理脚本 (v2.13 官方对齐版)
# 修复核心：严格遵循官方教程安装 build-essential
# 兜底策略：如果编译失败，自动使用 --omit=optional 跳过原生模块
# 适用于 Debian / Ubuntu (x86/ARM)

set -u

# ================= 配置区域 =================
readonly MANAGER_ROOT="$HOME/telebox_manager"
readonly INSTANCES_DIR="$MANAGER_ROOT/instances"
readonly LEGACY_APP_DIR="$HOME/telebox"
readonly LEGACY_CONFIG="$HOME/.telebox"
readonly NODE_VERSION="20"
readonly GITHUB_REPO="https://github.com/TeleBoxDev/TeleBox.git"
readonly MAX_MEMORY="192"

# 颜色定义
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly CYAN='\033[0;36m'
readonly NC='\033[0m'

# ================= 基础工具函数 =================

handle_error() {
    # 这里的错误处理不再强制退出，而是交给调用者决定
    local exit_code=$?
    if [ $exit_code -ne 0 ]; then
        echo -e "${YELLOW}[提示] 步骤执行异常 (代码: $exit_code)，尝试继续或进入兜底流程...${NC}"
    fi
}

check_dependencies() {
    # 1. 强制更新源 (官方教程步骤 1)
    echo -e "${BLUE}>>> [官方步骤] 更新系统源列表...${NC}"
    sudo apt-get update || echo -e "${YELLOW}源更新失败，尝试继续...${NC}"

    # 2. 强制安装编译工具 (官方教程步骤 1)
    # 即使之前装过，这里也会确保它是最新的
    echo -e "${BLUE}>>> [官方步骤] 安装基础构建工具 (build-essential)...${NC}"
    sudo apt-get install -y curl git build-essential g++ make python3 || true

    # 3. 安装 Node.js
    if ! command -v node >/dev/null 2>&1; then
        echo -e "${YELLOW}>>> [环境检查] 正在安装 Node.js ...${NC}"
        curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | sudo -E bash -
        sudo apt-get install -y nodejs
    fi

    if ! command -v pm2 >/dev/null 2>&1; then
        echo -e "${YELLOW}>>> [环境检查] 正在安装 PM2 ...${NC}"
        sudo npm install -g pm2
    fi

    mkdir -p "$INSTANCES_DIR"
}

get_instances() {
    if [ -d "$INSTANCES_DIR" ]; then
        ls -1 "$INSTANCES_DIR" 2>/dev/null
    fi
}

generate_ecosystem() {
    local input_name="$1"
    local dir="$2"
    local final_pm2_name="$input_name"

    if [[ "$input_name" != telebox* ]] && [[ "$input_name" != TeleBox* ]]; then
        final_pm2_name="telebox_${input_name}"
    fi

    cat > "$dir/ecosystem.config.js" <<EOF
module.exports = {
  apps: [
    {
      name: "${final_pm2_name}",
      script: "npm",
      args: "start",
      cwd: "${dir}",
      error_file: "${dir}/logs/error.log",
      out_file: "${dir}/logs/out.log",
      merge_logs: true,
      time: true,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 4000,
      node_args: "--optimize_for_size --max-old-space-size=${MAX_MEMORY} --expose-gc",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
}
EOF
}

# 核心：究极稳健的安装函数
smart_npm_install() {
    echo -e "${CYAN}>>> [依赖安装] 正在尝试标准安装...${NC}"

    # 临时关闭错误中断，由我们自己处理
    set +e

    # 方案 A: 标准安装 (尝试编译 bufferutil 等高性能组件)
    npm install --prefer-offline --no-audit
    local status_a=$?

    if [ $status_a -eq 0 ]; then
        echo -e "${GREEN}>>> 标准安装成功！${NC}"
        set -e
        return 0
    fi

    echo -e "${RED}>>> 标准安装失败 (通常是因为 g++ 缺失或内存不足)${NC}"
    echo -e "${YELLOW}>>> [自动修复] 启用 '--omit=optional' 模式安装...${NC}"
    echo -e "${YELLOW}>>> 这将跳过原生模块编译，直接使用纯 JS 版本 (功能完全一致)${NC}"

    # 清理失败的残留
    rm -rf node_modules

    # 方案 B: 跳过可选依赖 (核心修复)
    # 这会告诉 npm: "如果 bufferutil 编译不过，就别装它了，反正 TeleBox 也能跑"
    npm install --prefer-offline --no-audit --omit=optional
    local status_b=$?

    set -e

    if [ $status_b -eq 0 ]; then
        echo -e "${GREEN}>>> 修复模式安装成功！${NC}"
    else
        echo -e "${RED}>>> 安装仍然失败。请检查网络连接或磁盘空间。${NC}"
        # 只有方案B也失败了，才真正退出
        return 1
    fi
}

perform_cleanup() {
    echo -e "${BLUE}>>> [清理] 1. 停止并删除相关 PM2 进程...${NC}"
    if command -v pm2 >/dev/null 2>&1; then
        pm2 delete /telebox/ 2>/dev/null || true
        pm2 save >/dev/null 2>&1
    fi
    rm -rf "$MANAGER_ROOT"
    rm -rf "$LEGACY_APP_DIR"
    rm -rf "$LEGACY_CONFIG"*
    rm -rf "/tmp/telebox"*
    echo -e "${GREEN}>>> [清理] 系统清理完毕！${NC}"
}

# ================= 核心功能模块 =================

import_legacy() {
    if [ ! -d "$LEGACY_APP_DIR" ]; then echo -e "${RED}无旧版目录。${NC}"; return; fi
    echo -e "${BLUE}==== 导入旧版 ====${NC}"
    read -p "命名旧版实例 (如 legacy): " input_name
    local inst_name="${input_name:-legacy}"

    if [[ ! "$inst_name" =~ ^[a-zA-Z0-9_-]+$ ]]; then echo -e "${RED}非法名称${NC}"; return; fi
    local target_dir="$INSTANCES_DIR/$inst_name"
    if [ -d "$target_dir" ]; then echo -e "${RED}已存在${NC}"; return; fi

    pm2 delete telebox 2>/dev/null || true
    pkill -f "telebox" 2>/dev/null || true
    mv "$LEGACY_APP_DIR" "$target_dir"
    cd "$target_dir"
    smart_npm_install

    mkdir -p "$target_dir/logs"
    generate_ecosystem "$inst_name" "$target_dir"
    pm2 start ecosystem.config.js
    pm2 save
    echo -e "${GREEN}✔ 导入成功${NC}"
}

clean_reinstall_all() {
    echo -e "${RED}==== 全新安装 ====${NC}"
    read -p "确认清除所有数据？(y/N): " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then return; fi
    perform_cleanup
    mkdir -p "$INSTANCES_DIR"
    add_new_instance
}

add_new_instance() {
    local default_name="${1:-}"
    echo -e "${BLUE}==== 添加实例 ====${NC}"
    if [ -n "$default_name" ]; then echo -e "默认: [ ${default_name} ]"; fi
    read -p "实例名称: " input_name
    local inst_name="${input_name:-$default_name}"
    if [ -z "$inst_name" ]; then inst_name="telebox_01"; fi

    if [[ ! "$inst_name" =~ ^[a-zA-Z0-9_-]+$ ]]; then echo -e "${RED}名称非法${NC}"; return; fi
    local dir="$INSTANCES_DIR/$inst_name"
    if [ -d "$dir" ]; then echo -e "${RED}已存在${NC}"; return; fi

    mkdir -p "$dir"
    git clone "$GITHUB_REPO" "$dir"
    cd "$dir"

    # 使用智能安装
    smart_npm_install

    echo -e "${YELLOW}>>> [交互登录] 看到 'Connected' 后按 Ctrl+C <<<${NC}"
    read -p "按回车继续..."

    set +e
    trap 'echo -e "\n${GREEN}>>> 转入后台...${NC}"' SIGINT
    npm start
    trap - SIGINT
    set -e

    mkdir -p "$dir/logs"
    generate_ecosystem "$inst_name" "$dir"
    pm2 start ecosystem.config.js
    pm2 save
    echo -e "${GREEN}✔ 完成${NC}"
}

update_lossless() {
    echo -e "${BLUE}==== 无损更新 ====${NC}"
    local instances=$(get_instances)
    if [ -z "$instances" ]; then echo -e "${YELLOW}无实例。${NC}"; return; fi

    for inst in $instances; do
        echo -e "${CYAN}>>> 更新: $inst ...${NC}"
        local dir="$INSTANCES_DIR/$inst"
        if [ ! -d "$dir" ]; then continue; fi
        cd "$dir"

        generate_ecosystem "$inst" "$dir"
        pm2 stop ecosystem.config.js 2>/dev/null || true

        local current_branch=$(git rev-parse --abbrev-ref HEAD)
        git pull origin "$current_branch" || echo -e "${RED}Git 拉取失败${NC}"

        # 使用智能安装
        smart_npm_install

        pm2 restart ecosystem.config.js
        echo -e "${GREEN}✔ $inst 更新完毕${NC}"
    done
}

reinstall_core_lossless() {
    echo -e "${BLUE}==== 无损重装 (核心) ====${NC}"
    local instances=$(get_instances)
    if [ -z "$instances" ]; then echo -e "${YELLOW}无实例。${NC}"; return; fi

    echo "当前实例: $instances" | xargs
    read -p "输入重装目标 (all/名称): " target

    local list_to_process=""
    if [ "$target" == "all" ]; then list_to_process=$instances; else list_to_process=$target; fi

    for inst in $list_to_process; do
        if [ ! -d "$INSTANCES_DIR/$inst" ]; then continue; fi
        echo -e "${CYAN}>>> 重装: $inst ...${NC}"
        local dir="$INSTANCES_DIR/$inst"
        local temp_session="/tmp/tb_sess_bk_$inst"

        if [ -d "$dir" ]; then cd "$dir"; pm2 delete ecosystem.config.js 2>/dev/null || true; fi

        rm -rf "$temp_session"
        [ -d "$dir/session" ] && cp -r "$dir/session" "$temp_session"

        cd "$INSTANCES_DIR" || cd "$HOME"
        rm -rf "$dir"
        git clone "$GITHUB_REPO" "$dir"
        cd "$dir"

        # 核心：使用智能安装，确保 100% 成功
        smart_npm_install

        [ -d "$temp_session" ] && mv "$temp_session" "$dir/session"
        mkdir -p "$dir/logs"
        generate_ecosystem "$inst" "$dir"
        pm2 start ecosystem.config.js
        pm2 save
        echo -e "${GREEN}✔ $inst 重装完毕${NC}"
    done
}

memory_gc_info() {
    if command -v pm2 >/dev/null 2>&1; then pm2 list | grep -iE "telebox|App name|id"; else echo "PM2 未运行"; fi
}

uninstall_all() {
    read -p "确认删除所有？(y/N): " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then return; fi
    perform_cleanup
}

show_menu() {
    clear
    echo -e "${BLUE}#############################################${NC}"
    echo -e "${BLUE}#       TeleBox 多实例管理器 (v2.13)        #${NC}"
    echo -e "${BLUE}#############################################${NC}"
    echo -e "1. 全新安装"
    echo -e "2. 添加实例"
    echo -e "3. 无损更新"
    echo -e "4. 无损重装 (官方对齐+智能兜底)"
    echo -e "5. 内存状态"
    echo -e "6. 卸载全部"
    if [ -d "$LEGACY_APP_DIR" ]; then echo -e "${YELLOW}7. 导入旧版${NC}"; fi
    echo -e "0. 退出"
    echo -e "${BLUE}#############################################${NC}"
}

main() {
    check_dependencies
    while true; do
        show_menu
        read -p "选项: " choice
        case $choice in
            1) clean_reinstall_all ;;
            2) add_new_instance ;;
            3) update_lossless ;;
            4) reinstall_core_lossless ;;
            5) memory_gc_info ;;
            6) uninstall_all ;;
            7) import_legacy ;;
            0) exit 0 ;;
            *) echo "无效" ;;
        esac
        [ "$choice" != "0" ] && read -p "回车继续..."
    done
}

main