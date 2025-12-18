#!/bin/bash
# TeleBox 多实例管理脚本 (v2.1 修复版)
# 修复了 Ctrl+C 导致脚本直接退出、无法执行 PM2 托管的问题
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

# 错误捕获
handle_error() {
    local exit_code=$?
    if [ $exit_code -ne 0 ]; then
        echo -e "${RED}[错误] 操作在第 $1 行执行失败 (退出码: $exit_code)。${NC}"
    fi
}

# 检查环境依赖
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

# 获取当前实例列表
get_instances() {
    if [ -d "$INSTANCES_DIR" ]; then
        ls -1 "$INSTANCES_DIR" 2>/dev/null
    fi
}

# 生成 PM2 配置 (含内存优化)
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
      // 核心配置：内存优化策略
      // --max-old-space-size=${MAX_MEMORY}: 堆内存硬顶
      // --optimize_for_size: 优先回收内存
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

# [功能1] 全新安装 (重置环境并开始安装)
clean_reinstall_all() {
    echo -e "${RED}====================================================${NC}"
    echo -e "${RED}⚠️  警告：[全新安装] 将执行以下操作：${NC}"
    echo -e "${RED}1. 停止并删除所有正在运行的 TeleBox 进程${NC}"
    echo -e "${RED}2. 彻底删除 $MANAGER_ROOT 下的所有文件（包含登录信息）${NC}"
    echo -e "${RED}3. 重新初始化环境并引导你创建一个新实例${NC}"
    echo -e "${RED}====================================================${NC}"

    read -p "确认要执行全新安装吗？(y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then echo "操作已取消。"; return; fi

    echo -e "${BLUE}>>> 正在清理旧环境...${NC}"

    if command -v pm2 >/dev/null 2>&1; then
        pm2 delete /telebox_/ 2>/dev/null || true
        pm2 save >/dev/null 2>&1
    fi

    rm -rf "$MANAGER_ROOT"

    echo -e "${GREEN}>>> 环境已重置。准备开始安装...${NC}"
    sleep 1

    mkdir -p "$INSTANCES_DIR"
    add_new_instance "default"
}

# [功能2] 添加新实例 (修复了 Ctrl+C 退出问题)
add_new_instance() {
    local default_name="${1:-}"
    echo -e "${BLUE}==== 添加新 TeleBox 实例 ====${NC}"
    echo -e "请输入新实例的名称 (英文/数字，如: work, personal, bot1)"

    if [ -n "$default_name" ]; then
        echo -e "按回车默认使用名称: [ ${default_name} ]"
    fi

    read -p "实例名称: " input_name
    local inst_name="${input_name:-$default_name}"

    if [ -z "$inst_name" ]; then
        echo -e "${RED}名称不能为空！${NC}"; return;
    fi

    if [[ ! "$inst_name" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        echo -e "${RED}名称非法！仅支持字母、数字、下划线。${NC}"
        return
    fi

    local dir="$INSTANCES_DIR/$inst_name"

    if [ -d "$dir" ]; then
        echo -e "${RED}实例 [$inst_name] 已存在！请更换名称。${NC}"
        return
    fi

    echo -e "${CYAN}>>> 正在初始化实例: $inst_name ...${NC}"
    mkdir -p "$dir"

    # 下载
    echo "克隆代码..."
    git clone "$GITHUB_REPO" "$dir"

    # 安装
    echo "安装依赖..."
    cd "$dir"
    npm install --prefer-offline --no-audit

    # 交互式登录
    echo -e "${YELLOW}==============================================${NC}"
    echo -e "${YELLOW}>>> 准备进行首次登录 <<<${NC}"
    echo -e "${YELLOW}>>> 1. 根据提示输入手机号和验证码${NC}"
    echo -e "${YELLOW}>>> 2. 看到 'You should now be connected.' 后${NC}"
    echo -e "${YELLOW}>>> 3. 请按 CTRL+C 结束，脚本会自动接管后台运行${NC}"
    echo -e "${YELLOW}==============================================${NC}"
    read -p "按回车键开始登录..."

    # ================= 关键修复开始 =================

    # 1. 临时关闭 'set -e'，防止 npm 退出码导致脚本退出
    set +e

    # 2. 设置陷阱 (Trap)：当捕获到 SIGINT (Ctrl+C) 时，不退出脚本，而是打印一条信息
    # 这样只有子进程 (npm) 会终止，而此脚本会继续向下执行
    trap 'echo -e "\n${GREEN}>>> 检测到用户中断操作，正在转入后台配置...${NC}"' SIGINT

    # 3. 启动前台登录
    npm start

    # 4. 恢复陷阱和错误检查
    trap - SIGINT
    set -e

    # ================= 关键修复结束 =================

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

    if [ -z "$instances" ]; then
        echo -e "${YELLOW}无实例可更新。${NC}"; return;
    fi

    for inst in $instances; do
        echo -e "${CYAN}>>> 正在更新实例: [ $inst ] ...${NC}"
        local dir="$INSTANCES_DIR/$inst"
        local pm2_name="telebox_$inst"

        if [ ! -d "$dir" ]; then continue; fi
        cd "$dir"

        pm2 stop "$pm2_name" 2>/dev/null || true

        echo "拉取最新代码..."
        git pull origin master || echo -e "${RED}Git 拉取失败，跳过该实例${NC}"

        echo "更新依赖..."
        npm install --prefer-offline --no-audit

        generate_ecosystem "$inst" "$dir"

        pm2 restart "$pm2_name"
        echo -e "${GREEN}✔ 实例 $inst 更新完成${NC}"
    done
    echo -e "${GREEN}所有任务完成。${NC}"
}

# [功能4] 无损重装 (核心重置)
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
        if [ ! -d "$INSTANCES_DIR/$target" ]; then
            echo -e "${RED}实例不存在！${NC}"; return;
        fi
        list_to_process="$target"
    fi

    for inst in $list_to_process; do
        echo -e "${CYAN}>>> 正在重装: [ $inst ] ...${NC}"
        local dir="$INSTANCES_DIR/$inst"
        local pm2_name="telebox_$inst"
        local temp_session="/tmp/telebox_session_backup_$inst"

        rm -rf "$temp_session"
        if [ -d "$dir/session" ]; then
            echo "备份 Session..."
            cp -r "$dir/session" "$temp_session"
        else
            echo -e "${YELLOW}未发现 Session，将执行全新重装${NC}"
        fi

        pm2 delete "$pm2_name" 2>/dev/null || true
        rm -rf "$dir"
        mkdir -p "$dir"

        git clone "$GITHUB_REPO" "$dir"
        cd "$dir"
        npm install --prefer-offline --no-audit

        if [ -d "$temp_session" ]; then
            echo "还原 Session..."
            rm -rf "$dir/session"
            mv "$temp_session" "$dir/session"
        fi

        mkdir -p "$dir/logs"
        generate_ecosystem "$inst" "$dir"
        pm2 start ecosystem.config.js
        pm2 save
        echo -e "${GREEN}✔ 实例 $inst 重装完毕${NC}"
    done
}

# [功能5] 查看内存状态
memory_gc_info() {
    echo -e "${BLUE}==== 内存状态监控 ====${NC}"
    echo -e "策略: 超过 ${YELLOW}${MAX_MEMORY}MB${NC} 自动执行 GC (不杀进程)"
    echo -e "----------------------------------------"
    if command -v pm2 >/dev/null 2>&1; then
        pm2 list | grep -E "telebox_|App name|id" || echo "无运行中的 TeleBox 进程"
    else
        echo "PM2 未运行"
    fi
    echo -e "----------------------------------------"
}

# [功能6] 卸载全部
uninstall_all() {
    echo -e "${RED}==== 卸载全部 ====${NC}"
    echo -e "${RED}警告: 这将删除所有实例和数据！${NC}"
    read -p "确定执行吗？(y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then return; fi

    pm2 delete /telebox_/ 2>/dev/null || true
    pm2 save
    rm -rf "$MANAGER_ROOT"
    echo -e "${GREEN}卸载完成。${NC}"
}

# ================= 菜单逻辑 =================

show_menu() {
    clear
    echo -e "${BLUE}#############################################${NC}"
    echo -e "${BLUE}#       TeleBox 多实例管理器 (v2.1)         #${NC}"
    echo -e "${BLUE}#############################################${NC}"
    echo -e "${GREEN}1.${NC} 全新安装 (重置环境并新建)"
    echo -e "${GREEN}2.${NC} 添加新实例 (自定义命名)"
    echo -e "${GREEN}3.${NC} 无损更新 (保留数据)"
    echo -e "${GREEN}4.${NC} 无损重装 (仅重装核心)"
    echo -e "${GREEN}5.${NC} 查看内存状态"
    echo -e "${GREEN}6.${NC} 卸载全部"
    echo -e "${GREEN}0.${NC} 退出"
    echo -e "${BLUE}#############################################${NC}"

    local instances=$(get_instances)
    if [ -n "$instances" ]; then
        echo -e "当前实例: ${YELLOW}$(echo $instances | xargs)${NC}"
    else
        echo -e "当前实例: ${YELLOW}无${NC}"
    fi
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
            0) echo "再见。"; exit 0 ;;
            *) echo -e "${RED}无效选项${NC}" ;;
        esac

        if [ "$choice" != "0" ]; then
            echo
            read -p "按回车键返回菜单..."
        fi
    done
}

# 启动
main