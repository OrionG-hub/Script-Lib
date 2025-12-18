#!/bin/bash
# TeleBox 多实例管理脚本 (v2.20 卸载优化版)
# 新增：[卸载管理] 支持卸载单个实例 或 卸载全部
# 保留：智能安装、自动GC、旧版导入、无损更新
# 适用于 Debian / Ubuntu (x86/ARM)

set -u

# ================= 配置区域 =================
readonly MANAGER_ROOT="$HOME/telebox_manager"
readonly INSTANCES_DIR="$MANAGER_ROOT/instances"
readonly LEGACY_APP_DIR="$HOME/telebox"
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
        echo -e "${YELLOW}[提示] 步骤异常 (代码: $exit_code)，尝试继续...${NC}"
    fi
}

init_environment_checks() {
    echo -e "${BLUE}>>> [环境准备] 检查系统依赖...${NC}"
    if ! command -v g++ >/dev/null 2>&1 || ! command -v make >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
        echo -e "${YELLOW}>>> [环境补全] 安装编译工具...${NC}"
        sudo apt-get update || true
        sudo apt-get install -y curl git build-essential g++ make python3 python-is-python3 || true
    fi
    if ! command -v node >/dev/null 2>&1; then
        echo -e "${YELLOW}>>> [环境补全] 安装 Node.js ${NODE_VERSION}...${NC}"
        curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | sudo -E bash -
        sudo apt-get install -y nodejs
    fi
    if ! command -v pm2 >/dev/null 2>&1; then
        echo -e "${YELLOW}>>> [环境补全] 安装 PM2...${NC}"
        sudo npm install -g pm2
    fi
    mkdir -p "$INSTANCES_DIR"
    echo -e "${GREEN}>>> [环境准备] 就绪！${NC}"
    echo
}

get_instances() {
    if [ -d "$INSTANCES_DIR" ]; then ls -1 "$INSTANCES_DIR" 2>/dev/null; fi
}

generate_ecosystem() {
    local input_name="$1"
    local dir="$2"
    local final_pm2_name="$input_name"
    if [[ "$input_name" != telebox* ]] && [[ "$input_name" != TeleBox* ]]; then final_pm2_name="telebox_${input_name}"; fi
    cat > "$dir/ecosystem.config.js" <<EOF
module.exports = {
  apps: [{
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
    env: { NODE_ENV: "production" }
  }]
}
EOF
}

smart_npm_install() {
    echo -e "${CYAN}>>> [依赖安装] 尝试标准模式...${NC}"
    set +e
    npm install --prefer-offline --no-audit
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}>>> 标准安装成功！${NC}"; set -e; return 0;
    fi
    echo -e "${RED}>>> 标准安装失败，切换兼容模式 (跳过编译)...${NC}"
    rm -rf node_modules
    npm install --prefer-offline --no-audit --omit=optional
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}>>> 兼容模式安装成功！${NC}"; set -e;
    else
        echo -e "${RED}>>> 安装失败，请检查网络。${NC}"; return 1;
    fi
}

# 彻底清理所有内容
perform_cleanup_all() {
    echo -e "${BLUE}>>> [清理] 停止进程并删除所有文件...${NC}"
    if command -v pm2 >/dev/null 2>&1; then pm2 delete /telebox/ 2>/dev/null || true; pm2 save >/dev/null 2>&1; fi
    rm -rf "$MANAGER_ROOT" "$LEGACY_APP_DIR" "$HOME/.telebox"* "/tmp/telebox"*
    echo -e "${GREEN}>>> [清理] 全部完成！${NC}"
}

# 核心：通用数据迁移逻辑
handle_data_migration() {
    local src="$1"
    local dest="$2"
    local items=("my_session" "session" "plugins" "assets" "data" "temp" ".env" "config.json" "input.json")
    echo -e "${CYAN}   - [数据迁移] 扫描并迁移关键数据...${NC}"
    mkdir -p "$dest"
    for item in "${items[@]}"; do
        if [ -e "$src/$item" ]; then echo "     迁移: $item..."; cp -a "$src/$item" "$dest/"; fi
    done
    find "$src" -maxdepth 1 -name "*.json" ! -name "package.json" ! -name "package-lock.json" ! -name "tsconfig.json" -exec cp -a {} "$dest/" \; 2>/dev/null || true
}

# ================= 核心功能模块 =================

import_legacy() {
    init_environment_checks
    if [ ! -d "$LEGACY_APP_DIR" ]; then echo -e "${RED}无旧版目录。${NC}"; return; fi
    echo -e "${BLUE}==== 导入旧版 (数据注入模式) ====${NC}"
    read -p "命名实例 (如 legacy): " input_name
    local inst_name="${input_name:-legacy}"
    if [[ ! "$inst_name" =~ ^[a-zA-Z0-9_-]+$ ]]; then echo -e "${RED}名称非法${NC}"; return; fi
    local target_dir="$INSTANCES_DIR/$inst_name"
    if [ -d "$target_dir" ]; then echo -e "${RED}已存在${NC}"; return; fi

    echo -e "${CYAN}>>> [1/5] 停止旧进程...${NC}"
    pm2 delete telebox 2>/dev/null || true
    pkill -f "telebox" 2>/dev/null || true

    echo -e "${CYAN}>>> [2/5] 准备新环境...${NC}"
    mkdir -p "$target_dir"
    git clone "$GITHUB_REPO" "$target_dir"

    echo -e "${CYAN}>>> [3/5] 注入旧数据...${NC}"
    handle_data_migration "$LEGACY_APP_DIR" "$target_dir"

    echo -e "${CYAN}>>> [4/5] 安装依赖...${NC}"
    cd "$target_dir"
    smart_npm_install

    echo -e "${CYAN}>>> [5/5] 启动服务...${NC}"
    mkdir -p "$target_dir/logs"
    generate_ecosystem "$inst_name" "$target_dir"
    pm2 start ecosystem.config.js; pm2 save

    local backup_name="${LEGACY_APP_DIR}_backup_$(date +%s)"
    mv "$LEGACY_APP_DIR" "$backup_name"
    echo -e "${GREEN}✔ 导入成功！旧版已备份为: ${YELLOW}${backup_name}${NC}"
}

clean_reinstall_all() {
    echo -e "${RED}==== 全新安装 ====${NC}"
    read -p "确认清除所有数据？(y/N): " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then return; fi
    perform_cleanup_all
    init_environment_checks
    echo -e "${GREEN}>>> 3秒后开始安装...${NC}"
    sleep 3
    add_new_instance_logic
}

add_new_instance() {
    init_environment_checks
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
    echo -e "${YELLOW}>>> [4/5] 交互登录: 看到 Connected 后按 Ctrl+C <<<${NC}"
    read -p "按回车继续..."
    echo -e "\n${RED}>>> [等待] 看到 'You should now be connected.' 后 -> 按 Ctrl+C <<<${NC}\n"
    set +e; trap 'echo -e "\n${GREEN}>>> 转入后台...${NC}"' SIGINT; npm start; trap - SIGINT; set -e
    echo -e "\n${CYAN}>>> [5/5] 配置 PM2...${NC}"
    mkdir -p "$dir/logs"
    generate_ecosystem "$inst_name" "$dir"
    pm2 start ecosystem.config.js; pm2 save
    echo -e "${GREEN}✔ 完成${NC}"
}

update_lossless() {
    echo -e "${BLUE}==== 无损更新 ====${NC}"
    local instances=$(get_instances)
    if [ -z "$instances" ]; then echo -e "${YELLOW}无实例。${NC}"; return; fi
    init_environment_checks
    for inst in $instances; do
        echo -e "${CYAN}>>> 更新: $inst ...${NC}"
        local dir="$INSTANCES_DIR/$inst"
        if [ ! -d "$dir" ]; then continue; fi
        cd "$dir"
        generate_ecosystem "$inst" "$dir"
        pm2 stop ecosystem.config.js 2>/dev/null || true
        git pull origin "$(git rev-parse --abbrev-ref HEAD)" || echo -e "${RED}Git 失败${NC}"
        smart_npm_install
        pm2 restart ecosystem.config.js
        echo -e "${GREEN}✔ $inst 完成${NC}"
    done
}

# [功能5] 卸载管理逻辑
uninstall_logic() {
    echo -e "${RED}==== 卸载管理 ====${NC}"
    local instances=$(get_instances)

    if [ -z "$instances" ]; then
        echo -e "${YELLOW}当前无受管实例。${NC}"
        read -p "是否彻底清除管理器及残留文件？(y/N): " confirm
        if [[ "$confirm" =~ ^[Yy]$ ]]; then perform_cleanup_all; fi
        return
    fi

    echo -e "当前实例: ${YELLOW}$(echo $instances | xargs)${NC}"
    echo -e "1. 输入 ${GREEN}实例名称${NC} 仅卸载该实例 (数据会丢失)"
    echo -e "2. 输入 ${RED}all${NC} 卸载全部并清除管理器"
    echo
    read -p "请输入目标: " target

    if [ "$target" == "all" ]; then
        read -p "确认彻底删除所有内容？(y/N): " confirm
        if [[ "$confirm" =~ ^[Yy]$ ]]; then perform_cleanup_all; fi
    else
        # 检查实例是否存在
        local dir="$INSTANCES_DIR/$target"
        if [ ! -d "$dir" ]; then
            echo -e "${RED}错误：未找到实例 [$target]${NC}"
            return
        fi

        echo -e "${BLUE}正在卸载单个实例: $target ...${NC}"
        # 停止 PM2
        if [ -f "$dir/ecosystem.config.js" ]; then
            cd "$dir"
            pm2 delete ecosystem.config.js 2>/dev/null || true
            pm2 save >/dev/null 2>&1
        fi
        # 删除目录
        cd "$MANAGER_ROOT" || cd "$HOME"
        rm -rf "$dir"
        echo -e "${GREEN}✔ 实例 $target 已卸载${NC}"
    fi
}

memory_gc_info() { echo -e "${BLUE}==== 内存状态 ====${NC}"; if command -v pm2 >/dev/null 2>&1; then pm2 list | grep -iE "telebox|App name|id"; else echo "PM2 未运行"; fi; }

show_menu() {
    clear
    echo -e "${BLUE}#############################################${NC}"
    echo -e "${BLUE}#       TeleBox 多实例管理器 (v2.20)        #${NC}"
    echo -e "${BLUE}#############################################${NC}"
    echo -e "1. 全新安装 (清理+新建)"
    echo -e "2. 添加实例"
    echo -e "3. 无损更新 (仅更新代码和依赖)"
    echo -e "4. 查看内存状态"
    echo -e "5. 卸载管理 (单个/全部)"
    if [ -d "$LEGACY_APP_DIR" ]; then echo -e "${YELLOW}6. 导入旧版 (数据注入模式)${NC}"; fi
    echo -e "0. 退出"
    echo -e "${BLUE}#############################################${NC}"
    echo -e "当前实例: ${YELLOW}$(get_instances | xargs)${NC}"
    echo
}

main() { while true; do show_menu; read -p "请选择: " choice; echo; case $choice in 1) clean_reinstall_all;; 2) add_new_instance;; 3) update_lossless;; 4) memory_gc_info;; 5) uninstall_logic;; 6) import_legacy;; 0) exit 0;; *) echo "无效";; esac; [ "$choice" != "0" ] && read -p "回车继续..."; done; }
main