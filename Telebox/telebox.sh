#!/bin/bash
# TeleBox 多实例管理脚本 (v2.2)
# 修复：解决“全新安装”时因回车符残留导致跳过命名的问题
# 修复：Ctrl+C 信号正确接管
# 适用于 Debian / Ubuntu

set -u

# ================= 配置区域 =================
readonly MANAGER_ROOT="$HOME/telebox_manager"
readonly INSTANCES_DIR="$MANAGER_ROOT/instances"
readonly NODE_VERSION="20"
readonly GITHUB_REPO="https://github.com/TeleBoxDev/TeleBox.git"
# 内存限制 (MB)，超过此数值触发 GC
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
        echo -e "${RED}[错误] 操作在第 $1 行执行失败 (退出码: $exit_code)。${NC}"
    fi
}

check_dependencies() {
    if ! command -v node >/dev/null 2>&1; then
        echo -e "${YELLOW}正在安装 Node.js ...${NC}"
        sudo apt-get update
        sudo apt-get install -y curl git build-essential
        curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | sudo -E bash -
        sudo apt-get install -y nodejs
    fi

    if ! command -v pm2 >/dev/null 2>&1; then
        echo -e "${YELLOW}正在安装 PM2 ...${NC}"
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
    local name="telebox_$1"
    local dir="$2"
    cat > "$dir/ecosystem.config.js" <<EOF
module.exports = {
  apps: [
    {
      name: "${name}",
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

# ================= 核心功能模块 =================

# [功能1] 全新安装
clean_reinstall_all() {
    echo -e "${RED}====================================================${NC}"
    echo -e "${RED}⚠️  警告：[全新安装] 将执行以下操作：${NC}"
    echo -e "${RED}1. 停止并删除所有 TeleBox 进程${NC}"
    echo -e "${RED}2. 删除 $MANAGER_ROOT 下所有数据${NC}"
    echo -e "${RED}3. 重新初始化环境${NC}"
    echo -e "${RED}====================================================${NC}"

    # 修复点：去掉 -n 1，强制用户输入 y 后按回车，消耗掉换行符
    read -p "确认要执行全新安装吗？(输入 y 并回车): " confirm
    echo
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then echo "操作已取消。"; return; fi

    echo -e "${BLUE}>>> 正在清理旧环境...${NC}"
    if command -v pm2 >/dev/null 2>&1; then
        pm2 delete /telebox_/ 2>/dev/null || true
        pm2 save >/dev/null 2>&1
    fi
    rm -rf "$MANAGER_ROOT"

    echo -e "${GREEN}>>> 环境已重置。准备开始安装...${NC}"
    sleep 1
    mkdir -p "$INSTANCES_DIR"

    # 这里不传默认参数，让用户必须自己思考名字，或者在函数内处理
    add_new_instance
}

# [功能2] 添加新实例
add_new_instance() {
    # 如果没传参数，就是空
    local default_name="${1:-}"

    echo -e "${BLUE}==== 添加新 TeleBox 实例 ====${NC}"
    echo -e "请输入新实例的名称 (英文/数字，如: work, personal)"

    if [ -n "$default_name" ]; then
        echo -e "按回车默认使用名称: [ ${default_name} ]"
    fi

    # 这里的 read 会老实等待输入
    read -p "实例名称: " input_name

    # 逻辑：如果有输入则用输入；如果没输入但有默认值，用默认值；否则报错
    local inst_name="${input_name:-$default_name}"

    if [ -z "$inst_name" ]; then
        # 如果既没输入也没默认值（比如全新安装时），给一个硬性默认
        inst_name="telebox_01"
        echo -e "${YELLOW}未检测到输入，将自动命名为: ${inst_name}${NC}"
    fi

    # 名称合法性检查
    if [[ ! "$inst_name" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        echo -e "${RED}名称非法！仅支持字母、数字、下划线。请重试。${NC}"
        return
    fi

    local dir="$INSTANCES_DIR/$inst_name"
    if [ -d "$dir" ]; then
        echo -e "${RED}实例 [$inst_name] 已存在！请更换名称。${NC}"
        return
    fi

    echo -e "${CYAN}>>> 正在初始化实例: $inst_name ...${NC}"
    mkdir -p "$dir"

    echo "克隆代码..."
    git clone "$GITHUB_REPO" "$dir"

    echo "安装依赖..."
    cd "$dir"
    npm install --prefer-offline --no-audit

    echo -e "${YELLOW}==============================================${NC}"
    echo -e "${YELLOW}>>> 准备进行首次登录 <<<${NC}"
    echo -e "${YELLOW}>>> 登录成功后请按 CTRL+C，脚本会自动接管 <<<${NC}"
    echo -e "${YELLOW}==============================================${NC}"
    read -p "按回车键开始登录..."

    # 信号捕获修复
    set +e
    trap 'echo -e "\n${GREEN}>>> 检测到用户中断，转入后台配置...${NC}"' SIGINT
    npm start
    trap - SIGINT
    set -e

    echo -e "\n${GREEN}>>> 正在配置 PM2 后台托管...${NC}"
    mkdir -p "$dir/logs"
    generate_ecosystem "$inst_name" "$dir"

    pm2 start ecosystem.config.js
    pm2 save

    echo -e "${GREEN}✔ 实例 [$inst_name] 安装并启动成功！${NC}"
    echo -e "内存限制策略: ${MAX_MEMORY}MB (自动GC)"
}

# [功能3] 无损更新
update_lossless() {
    echo -e "${BLUE}==== 无损更新 (保留 Session) ====${NC}"
    local instances=$(get_instances)
    if [ -z "$instances" ]; then echo -e "${YELLOW}无实例。${NC}"; return; fi

    for inst in $instances; do
        echo -e "${CYAN}>>> 更新实例: [ $inst ] ...${NC}"
        local dir="$INSTANCES_DIR/$inst"
        local pm2_name="telebox_$inst"

        if [ ! -d "$dir" ]; then continue; fi
        cd "$dir"

        pm2 stop "$pm2_name" 2>/dev/null || true
        git pull origin master || echo -e "${RED}Git 拉取失败${NC}"
        npm install --prefer-offline --no-audit
        generate_ecosystem "$inst" "$dir"
        pm2 restart "$pm2_name"
        echo -e "${GREEN}✔ $inst 完成${NC}"
    done
}

# [功能4] 无损重装
reinstall_core_lossless() {
    echo -e "${BLUE}==== 无损重装 (保留登录，重装核心) ====${NC}"
    local instances=$(get_instances)
    if [ -z "$instances" ]; then echo -e "${YELLOW}无实例。${NC}"; return; fi

    echo "当前实例: $instances" | xargs
    read -p "输入要重装的实例名称 (输入 'all' 重装所有): " target

    local list_to_process=""
    if [ "$target" == "all" ]; then
        list_to_process=$instances
    else
        if [ ! -d "$INSTANCES_DIR/$target" ]; then echo -e "${RED}不存在。${NC}"; return; fi
        list_to_process="$target"
    fi

    for inst in $list_to_process; do
        echo -e "${CYAN}>>> 重装: [ $inst ] ...${NC}"
        local dir="$INSTANCES_DIR/$inst"
        local pm2_name="telebox_$inst"
        local temp_session="/tmp/tb_sess_bk_$inst"

        rm -rf "$temp_session"
        [ -d "$dir/session" ] && cp -r "$dir/session" "$temp_session"

        pm2 delete "$pm2_name" 2>/dev/null || true
        rm -rf "$dir"
        mkdir -p "$dir"

        git clone "$GITHUB_REPO" "$dir"
        cd "$dir"
        npm install --prefer-offline --no-audit

        [ -d "$temp_session" ] && mv "$temp_session" "$dir/session"

        mkdir -p "$dir/logs"
        generate_ecosystem "$inst" "$dir"
        pm2 start ecosystem.config.js
        pm2 save
    done
}

# [功能5] 内存状态
memory_gc_info() {
    echo -e "${BLUE}==== 内存状态监控 ====${NC}"
    if command -v pm2 >/dev/null 2>&1; then
        pm2 list | grep -E "telebox_|App name|id" || echo "无运行中的 TeleBox 进程"
    else
        echo "PM2 未运行"
    fi
}

# [功能6] 卸载全部
uninstall_all() {
    echo -e "${RED}==== 卸载全部 ====${NC}"
    read -p "删除所有数据？(y/N): " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then return; fi

    pm2 delete /telebox_/ 2>/dev/null || true
    pm2 save
    rm -rf "$MANAGER_ROOT"
    echo -e "${GREEN}已卸载。${NC}"
}

# ================= 菜单逻辑 =================
show_menu() {
    clear
    echo -e "${BLUE}#############################################${NC}"
    echo -e "${BLUE}#       TeleBox 多实例管理器 (v2.2)         #${NC}"
    echo -e "${BLUE}#############################################${NC}"
    echo -e "1. 全新安装 (重置环境并新建)"
    echo -e "2. 添加新实例 (自定义命名)"
    echo -e "3. 无损更新 (保留数据)"
    echo -e "4. 无损重装 (仅重装核心)"
    echo -e "5. 查看内存状态"
    echo -e "6. 卸载全部"
    echo -e "0. 退出"
    echo -e "${BLUE}#############################################${NC}"
    local instances=$(get_instances)
    echo -e "当前实例: ${YELLOW}${instances:-无}${NC}"
    echo
}

main() {
    check_dependencies
    while true; do
        show_menu
        read -p "请选择 [0-6]: " choice
        echo
        case $choice in
            1) clean_reinstall_all ;;
            2) add_new_instance ;;
            3) update_lossless ;;
            4) reinstall_core_lossless ;;
            5) memory_gc_info ;;
            6) uninstall_all ;;
            0) exit 0 ;;
            *) echo "无效选项" ;;
        esac
        [ "$choice" != "0" ] && read -p "按回车键返回菜单..."
    done
}

main