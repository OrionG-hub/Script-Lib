#!/bin/bash
# TeleBox 多实例管理脚本 (Pro版)
# 支持多进程、无损更新、智能内存GC、隔离环境
# 适用于 Debian / Ubuntu

set -u

# ================= 配置区域 =================
# 所有实例的根目录
readonly MANAGER_ROOT="$HOME/telebox_manager"
readonly INSTANCES_DIR="$MANAGER_ROOT/instances"
readonly NODE_VERSION="20"
readonly GITHUB_REPO="https://github.com/TeleBoxDev/TeleBox.git"

# 内存管理配置 (单位 MB)
readonly MAX_MEMORY="192"

# 颜色定义
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly CYAN='\033[0;36m'
readonly NC='\033[0m'

# ================= 基础函数 =================

# 错误处理
handle_error() {
    echo -e "${RED}[ERROR] 操作在第 $1 行失败。请检查日志。${NC}"
    # 不退出，让用户有机会看到错误，但在某些严重错误下可能需要手动退出
}
trap 'handle_error $LINENO' ERR

# 检查并安装基础依赖
check_dependencies() {
    if ! command -v node >/dev/null 2>&1; then
        echo -e "${YELLOW}未检测到 Node.js，正在安装...${NC}"
        sudo apt-get update
        sudo apt-get install -y curl git build-essential
        curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | sudo -E bash -
        sudo apt-get install -y nodejs
    fi

    if ! command -v pm2 >/dev/null 2>&1; then
        echo -e "${YELLOW}未检测到 PM2，正在安装...${NC}"
        sudo npm install -g pm2
    fi

    mkdir -p "$INSTANCES_DIR"
}

# 获取当前所有实例名称
get_instances() {
    if [ -d "$INSTANCES_DIR" ]; then
        # 列出目录下所有文件夹名称
        ls -1 "$INSTANCES_DIR" 2>/dev/null
    fi
}

# ================= 核心功能函数 =================

# 生成 PM2 配置文件 (核心：内存控制)
# $1: 实例名称 (例如 work)
# $2: 实例路径
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
      // 日志配置
      error_file: "${dir}/logs/error.log",
      out_file: "${dir}/logs/out.log",
      merge_logs: true,
      time: true,

      // 进程守护配置
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 4000,

      // 内存与性能优化 (关键需求)
      // --max-old-space-size=${MAX_MEMORY}: 告诉 V8 堆内存超过 ${MAX_MEMORY}MB 时必须进行 GC
      // --optimize_for_size: 告诉 V8 优化内存占用而不是执行速度
      // --expose-gc: 允许手动触发 GC (备用)
      node_args: "--optimize_for_size --max-old-space-size=${MAX_MEMORY} --expose-gc",

      env: {
        NODE_ENV: "production"
      }
    }
  ]
}
EOF
}

# 1. 彻底删除并重新安装所有
clean_reinstall_all() {
    echo -e "${RED}警告：此操作将删除所有 TeleBox 实例、登录信息和配置！${NC}"
    read -p "确认要全部删除并重置吗？(y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then return; fi

    echo -e "${BLUE}>>> 停止所有 TeleBox 进程...${NC}"
    pm2 delete /telebox_/ 2>/dev/null || true

    echo -e "${BLUE}>>> 删除所有文件...${NC}"
    rm -rf "$MANAGER_ROOT"

    echo -e "${GREEN}>>> 清理完成，开始全新安装...${NC}"
    mkdir -p "$INSTANCES_DIR"
    add_new_instance
}

# 2. 无损更新 (支持批量)
update_lossless() {
    echo -e "${BLUE}==== 无损更新（保留 Session） ====${NC}"
    local instances=$(get_instances)

    if [ -z "$instances" ]; then
        echo -e "${YELLOW}当前没有安装任何实例。${NC}"
        return
    fi

    for inst in $instances; do
        echo -e "${CYAN}正在更新实例: [ $inst ] ...${NC}"
        local dir="$INSTANCES_DIR/$inst"
        local pm2_name="telebox_$inst"

        cd "$dir" || continue

        # 停止进程
        pm2 stop "$pm2_name" 2>/dev/null || true

        # 更新代码
        git pull origin master || echo -e "${RED}Git 拉取失败，跳过...${NC}"

        # 更新依赖
        npm install --prefer-offline --no-audit

        # 重新生成配置以确保内存设置最新
        generate_ecosystem "$inst" "$dir"

        # 重启
        pm2 restart "$pm2_name"
        echo -e "${GREEN}实例 $inst 更新完成！${NC}"
    done

    echo -e "${GREEN}所有实例更新完毕。${NC}"
}

# 3. 无损重装 (删除核心文件，保留 Session)
reinstall_core_lossless() {
    echo -e "${BLUE}==== 无损重装核心（修复损坏的安装） ====${NC}"
    local instances=$(get_instances)

    if [ -z "$instances" ]; then echo -e "${YELLOW}无实例。${NC}"; return; fi

    echo "发现以下实例："
    echo "$instances"
    echo
    read -p "请输入要重装的实例名称 (输入 'all' 重装所有): " target

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
        echo -e "${CYAN}正在重装实例: [ $inst ] ...${NC}"
        local dir="$INSTANCES_DIR/$inst"
        local pm2_name="telebox_$inst"
        local temp_session="/tmp/telebox_session_$inst_$(date +%s)"

        # 1. 备份 Session
        if [ -d "$dir/session" ]; then
            echo "备份 Session 数据..."
            cp -r "$dir/session" "$temp_session"
        else
            echo -e "${YELLOW}警告：未找到 Session 数据，将视为全新安装。${NC}"
        fi

        # 2. 清理
        pm2 delete "$pm2_name" 2>/dev/null || true
        rm -rf "$dir"
        mkdir -p "$dir"

        # 3. 重新下载
        cd "$dir"
        git clone "$GITHUB_REPO" .
        npm install --prefer-offline --no-audit

        # 4. 还原 Session
        if [ -d "$temp_session" ]; then
            echo "还原 Session 数据..."
            rm -rf "$dir/session"
            mv "$temp_session" "$dir/session"
        fi

        # 5. 重启
        mkdir -p "$dir/logs"
        generate_ecosystem "$inst" "$dir"
        pm2 start ecosystem.config.js
        pm2 save
        echo -e "${GREEN}实例 $inst 重装完成！${NC}"
    done
}

# 4. 安装额外的 TeleBox 实例
add_new_instance() {
    echo -e "${BLUE}==== 添加新 TeleBox 实例 ====${NC}"
    echo -e "请输入新实例的名称 (英文/数字，例如: work, personal, bot1)"
    read -p "实例名称: " inst_name

    # 简单的名称校验
    if [[ ! "$inst_name" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        echo -e "${RED}名称包含非法字符，请仅使用字母、数字、下划线。${NC}"
        return
    fi

    local dir="$INSTANCES_DIR/$inst_name"

    if [ -d "$dir" ]; then
        echo -e "${RED}该实例名称已存在！请先卸载或换个名字。${NC}"
        return
    fi

    echo -e "${CYAN}正在初始化实例: $inst_name ...${NC}"
    mkdir -p "$dir"
    cd "$dir"

    # 克隆
    echo "克隆代码库..."
    git clone "$GITHUB_REPO" .

    # 安装依赖
    echo "安装依赖..."
    npm install --prefer-offline --no-audit

    # 首次登录交互
    echo -e "${YELLOW}==============================================${NC}"
    echo -e "${YELLOW}>>> 准备进行首次登录 <<<${NC}"
    echo -e "${YELLOW}>>> 登录成功并看到 'You should now be connected' 后 <<<${NC}"
    echo -e "${YELLOW}>>> 请按 CTRL+C 结束前台进程，脚本将自动接管 <<<${NC}"
    echo -e "${YELLOW}==============================================${NC}"
    read -p "按回车键开始登录..."

    # 临时允许错误以捕获 Ctrl+C
    set +e
    npm start
    set -e

    echo -e "\n${GREEN}登录步骤结束。正在配置 PM2 托管...${NC}"

    # 配置 PM2
    mkdir -p "$dir/logs"
    generate_ecosystem "$inst_name" "$dir"

    pm2 start ecosystem.config.js
    pm2 save

    echo -e "${GREEN}实例 $inst_name 已成功添加并运行！${NC}"
    echo -e "内存限制已设置为: ${MAX_MEMORY}MB (超出将自动GC)"
}

# 5. 卸载全部
uninstall_all() {
    echo -e "${RED}==== 卸载全部 TeleBox ====${NC}"
    read -p "确定要删除所有 TeleBox 实例和数据吗？(y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then return; fi

    pm2 delete /telebox_/ 2>/dev/null || true
    pm2 save
    rm -rf "$MANAGER_ROOT"
    echo -e "${GREEN}所有 TeleBox 数据已清除。${NC}"
}

# 6. 内存管理说明与手动GC (虽然自动化了，但也提供手动选项)
memory_gc_info() {
    echo -e "${BLUE}==== 内存管理策略说明 ====${NC}"
    echo -e "本脚本已通过 Node.js V8 标志实现了以下自动化策略："
    echo -e "1. ${YELLOW}--optimize_for_size${NC}: 告诉引擎优先回收内存，而非提升执行速度。"
    echo -e "2. ${YELLOW}--max-old-space-size=${MAX_MEMORY}${NC}: 堆内存硬性限制。"
    echo -e "   - 当内存接近 ${MAX_MEMORY}MB 时，Node.js 会**强制**执行 GC。"
    echo -e "   - 只有在 GC 后内存依然不足时，进程才会崩溃重启（这是保护机制）。"
    echo -e "   - 这是一个**不杀进程**的软性清理方案。"
    echo
    echo -e "${CYAN}当前所有 TeleBox 进程内存状态：${NC}"
    pm2 list | grep "telebox_" || echo "无运行中的实例"
}

# ================= 菜单系统 =================

show_menu() {
    clear
    echo -e "${BLUE}#############################################${NC}"
    echo -e "${BLUE}#         TeleBox 多实例管理器 (Pro)        #${NC}"
    echo -e "${BLUE}#############################################${NC}"
    echo -e "${GREEN}1.${NC} 添加新实例 (自定义命名)"
    echo -e "${GREEN}2.${NC} 无损更新 (保留数据更新代码)"
    echo -e "${GREEN}3.${NC} 无损重装 (保留登录，重装核心)"
    echo -e "${GREEN}4.${NC} 全新安装 (⚠️ 删除所有数据)"
    echo -e "${GREEN}5.${NC} 卸载全部"
    echo -e "${GREEN}6.${NC} 查看内存状态 & GC策略"
    echo -e "${GREEN}0.${NC} 退出"
    echo -e "${BLUE}#############################################${NC}"

    local instances=$(get_instances)
    if [ -n "$instances" ]; then
        echo -e "${YELLOW}当前已安装实例:${NC}"
        echo "$instances" | xargs -n1 | sed 's/^/- /'
    else
        echo -e "${YELLOW}当前无安装实例${NC}"
    fi
    echo
}

main() {
    check_dependencies

    while true; do
        show_menu
        read -p "请输入选项 [0-6]: " choice
        echo

        case $choice in
            1) add_new_instance ;;
            2) update_lossless ;;
            3) reinstall_core_lossless ;;
            4) clean_reinstall_all ;;
            5) uninstall_all ;;
            6) memory_gc_info; read -p "按回车返回..." ;;
            0) exit 0 ;;
            *) echo -e "${RED}无效选项${NC}"; sleep 1 ;;
        esac

        echo
        read -p "操作完成，按回车键返回主菜单..."
    done
}

# 启动脚本
main