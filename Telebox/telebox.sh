#!/bin/bash
# TeleBox 多实例管理脚本 (v2.15)
# 逻辑确认：启动时绝不运行 apt update，秒进菜单
# 只有在选择 1/2/3/4/7 时才触发环境检查
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
    local exit_code=$?
    if [ $exit_code -ne 0 ]; then
        echo -e "${YELLOW}[提示] 步骤执行异常 (代码: $exit_code)，尝试智能修复...${NC}"
    fi
}

# 延迟执行的环境检查函数
init_environment_checks() {
    echo -e "${BLUE}>>> [环境准备] 正在检查并配置系统依赖...${NC}"

    # 1. 基础构建工具 (只在缺失时安装)
    if ! command -v g++ >/dev/null 2>&1 || ! command -v make >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
        echo -e "${YELLOW}>>> [环境补全] 缺少编译工具，正在安装...${NC}"
        # 只有这里才会跑 apt update
        sudo apt-get update || true
        sudo apt-get install -y curl git build-essential g++ make python3 python-is-python3 || true
    fi

    # 2. Node.js
    if ! command -v node >/dev/null 2>&1; then
        echo -e "${YELLOW}>>> [环境补全] 安装 Node.js ${NODE_VERSION}...${NC}"
        curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | sudo -E bash -
        sudo apt-get install -y nodejs
    fi

    # 3. PM2
    if ! command -v pm2 >/dev/null 2>&1; then
        echo -e "${YELLOW}>>> [环境补全] 安装 PM2...${NC}"
        sudo npm install -g pm2
    fi

    mkdir -p "$INSTANCES_DIR"
    echo -e "${GREEN}>>> [环境准备] 就绪！${NC}"
    echo
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

# 智能安装兜底策略
smart_npm_install() {
    echo -e "${CYAN}>>> [依赖安装] 尝试标准模式 (含原生组件)...${NC}"
    set +e
    npm install --prefer-offline --no-audit
    local status_a=$?

    if [ $status_a -eq 0 ]; then
        echo -e "${GREEN}>>> 标准安装成功！${NC}"
        set -e
        return 0
    fi

    echo -e "${RED}>>> 标准安装失败 (编译环境异常)${NC}"
    echo -e "${YELLOW}>>> [智能修复] 切换至兼容模式 (跳过编译)...${NC}"

    rm -rf node_modules
    npm install --prefer-offline --no-audit --omit=optional
    local status_b=$?

    set -e
    if [ $status_b -eq 0 ]; then
        echo -e "${GREEN}>>> 兼容模式安装成功！${NC}"
    else
        echo -e "${RED}>>> 安装失败，请检查网络。${NC}"
        return 1
    fi
}

perform_cleanup() {
    echo -e "${BLUE}>>> [清理] 停止进程并删除文件...${NC}"
    if command -v pm2 >/dev/null 2>&1; then
        pm2 delete /telebox/ 2>/dev/null || true
        pm2 save >/dev/null 2>&1
    fi
    rm -rf "$MANAGER_ROOT"
    rm -rf "$LEGACY_APP_DIR"
    rm -rf "$LEGACY_CONFIG"*
    rm -rf "/tmp/telebox"*
    echo -e "${GREEN}>>> [清理] 完成！${NC}"
}

# ================= 功能入口 =================

import_legacy() {
    init_environment_checks # 按需加载

    if [ ! -d "$LEGACY_APP_DIR" ]; then echo -e "${RED}无旧版目录。${NC}"; return; fi
    echo -e "${BLUE}==== 导入旧版 ====${NC}"
    read -p "命名实例 (如 legacy): " input_name
    local inst_name="${input_name:-legacy}"
    if [[ ! "$inst_name" =~ ^[a-zA-Z0-9_-]+$ ]]; then echo -e "${RED}名称非法${NC}"; return; fi
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
    init_environment_checks # 清理后再检查

    echo -e "${GREEN}>>> 3秒后开始安装...${NC}"
    sleep 3
    add_new_instance_logic
}

add_new_instance() {
    init_environment_checks # 按需加载
    add_new_instance_logic "$@"
}

add_new_instance_logic() {
    local default_name="${1:-}"
    echo -e "${BLUE}==== 添加实例 ====${NC}"
    if [ -n "$default_name" ]; then echo -e "默认: [ ${default_name} ]"; fi
    read -p "实例名称: " input_name
    local inst_name="${input_name:-$default_name}"
    if [ -z "$inst_name" ]; then inst_name="telebox_01"; fi

    if [[ ! "$inst_name" =~ ^[a-zA-Z0-9_-]+$ ]]; then echo -e "${RED}名称非法${NC}"; return; fi
    local dir="$INSTANCES_DIR/$inst_name"
    if [ -d "$dir" ]; then echo -e "${RED}已存在${NC}"; return; fi

    echo -e "${CYAN}>>> [1/5] 创建目录...${NC}"
    mkdir -p "$dir"
    echo -e "${CYAN}>>> [2/5] 克隆代码...${NC}"
    git clone "$GITHUB_REPO" "$dir"

    echo -e "${CYAN}>>> [3/5] 安装依赖...${NC}"
    cd "$dir"
    smart_npm_install

    echo -e "${YELLOW}======================================================${NC}"
    echo -e "${YELLOW}>>> [4/5] 交互登录: 看到 Connected 后按 Ctrl+C <<<${NC}"
    echo -e "${YELLOW}======================================================${NC}"
    read -p "按回车继续..."
    echo -e "\n${RED}>>> [等待] 看到 'You should now be connected.' 后 -> 按 Ctrl+C <<<${NC}\n"

    set +e
    trap 'echo -e "\n${GREEN}>>> 转入后台...${NC}"' SIGINT
    npm start
    trap - SIGINT
    set -e

    echo -e "\n${CYAN}>>> [5/5] 配置 PM2...${NC}"
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

    init_environment_checks # 按需加载

    for inst in $instances; do
        echo -e "${CYAN}>>> 更新: $inst ...${NC}"
        local dir="$INSTANCES_DIR/$inst"
        if [ ! -d "$dir" ]; then continue; fi
        cd "$dir"
        generate_ecosystem "$inst" "$dir"
        pm2 stop ecosystem.config.js 2>/dev/null || true
        local current_branch=$(git rev-parse --abbrev-ref HEAD)
        git pull origin "$current_branch" || echo -e "${RED}Git 失败${NC}"
        smart_npm_install
        pm2 restart ecosystem.config.js
        echo -e "${GREEN}✔ $inst 完成${NC}"
    done
}

reinstall_core_lossless() {
    echo -e "${BLUE}==== 无损重装 ====${NC}"
    local instances=$(get_instances)
    if [ -z "$instances" ]; then echo -e "${YELLOW}无实例。${NC}"; return; fi

    echo "当前: $instances" | xargs
    read -p "目标 (all/名称): " target

    local list_to_process=""
    if [ "$target" == "all" ]; then list_to_process=$instances; else list_to_process=$target; fi

    init_environment_checks # 按需加载

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
        smart_npm_install

        [ -d "$temp_session" ] && mv "$temp_session" "$dir/session"
        mkdir -p "$dir/logs"
        generate_ecosystem "$inst" "$dir"
        pm2 start ecosystem.config.js
        pm2 save
        echo -e "${GREEN}✔ 重装完成${NC}"
    done
}

memory_gc_info() {
    # 纯查看，不需要安装依赖
    echo -e "${BLUE}==== 内存状态 ====${NC}"
    if command -v pm2 >/dev/null 2>&1; then pm2 list | grep -iE "telebox|App name|id"; else echo "PM2 未运行"; fi
}

uninstall_all() {
    # 纯清理，不需要安装依赖
    echo -e "${RED}==== 卸载全部 ====${NC}"
    read -p "确认删除所有？(y/N): " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then return; fi
    perform_cleanup
}

show_menu() {
    clear
    echo -e "${BLUE}#############################################${NC}"
    echo -e "${BLUE}#       TeleBox 多实例管理器 (v2.15)        #${NC}"
    echo -e "${BLUE}#############################################${NC}"
    echo -e "1. 全新安装 (清理+新建)"
    echo -e "2. 添加实例"
    echo -e "3. 无损更新"
    echo -e "4. 无损重装 (智能修复)"
    echo -e "5. 内存状态"
    echo -e "6. 卸载全部"
    if [ -d "$LEGACY_APP_DIR" ]; then echo -e "${YELLOW}7. 导入旧版${NC}"; fi
    echo -e "0. 退出"
    echo -e "${BLUE}#############################################${NC}"
    local instances=$(get_instances)
    echo -e "当前实例: ${YELLOW}${instances:-无}${NC}"
    echo
}

main() {
    while true; do
        show_menu
        read -p "请选择: " choice
        echo
        case $choice in
            1) clean_reinstall_all ;;
            2) add_new_instance ;;
            3) update_lossless ;;
            4) reinstall_core_lossless ;;
            5) memory_gc_info ;;
            6) uninstall_all ;;
            7) import_legacy ;;
            0) exit 0 ;;
            *) echo "无效选项" ;;
        esac
        [ "$choice" != "0" ] && read -p "按回车键返回菜单..."
    done
}

main