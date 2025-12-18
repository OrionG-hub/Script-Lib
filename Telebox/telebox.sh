#!/bin/bash
# TeleBox 多实例管理脚本 (v2.10)
# 修复：[无损重装] 彻底解决了 "Unable to read current working directory" 报错
# 原理：在删除旧目录前，强制脚本跳转到上级目录
# 包含：智能命名、自动GC、旧版导入、彻底清理等所有功能
# 适用于 Debian / Ubuntu

set -u

# ================= 配置区域 =================
readonly MANAGER_ROOT="$HOME/telebox_manager"
readonly INSTANCES_DIR="$MANAGER_ROOT/instances"
readonly LEGACY_APP_DIR="$HOME/telebox"
readonly LEGACY_CONFIG="$HOME/.telebox"
readonly NODE_VERSION="20"
readonly GITHUB_REPO="https://github.com/TeleBoxDev/TeleBox.git"
# 内存限制 (MB)
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
        echo -e "${YELLOW}>>> [环境检查] 正在安装 Node.js ...${NC}"
        sudo apt-get update
        sudo apt-get install -y curl git build-essential
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

# 核心配置生成器 (包含 GC 策略)
generate_ecosystem() {
    local input_name="$1"
    local dir="$2"
    local final_pm2_name="$input_name"

    # 智能命名逻辑
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

perform_cleanup() {
    echo -e "${BLUE}>>> [清理] 1. 停止并删除相关 PM2 进程...${NC}"
    if command -v pm2 >/dev/null 2>&1; then
        pm2 delete /telebox/ 2>/dev/null || true
        pm2 save >/dev/null 2>&1
    fi

    echo -e "${BLUE}>>> [清理] 2. 删除管理器目录...${NC}"
    rm -rf "$MANAGER_ROOT"
    rm -rf "$LEGACY_APP_DIR"
    rm -rf "$LEGACY_CONFIG"*
    rm -rf "/tmp/telebox"*

    echo -e "${GREEN}>>> [清理] 系统清理完毕！${NC}"
}

# ================= 核心功能模块 =================

# [功能7] 导入旧版
import_legacy() {
    if [ ! -d "$LEGACY_APP_DIR" ]; then
        echo -e "${RED}未检测到旧版目录 ($LEGACY_APP_DIR)，无需导入。${NC}"
        return
    fi

    echo -e "${BLUE}==== 导入旧版 TeleBox ====${NC}"
    echo -e "检测到手动安装的旧版本: $LEGACY_APP_DIR"

    read -p "请为导入的实例命名 (例如: legacy, old): " input_name
    local inst_name="${input_name:-legacy}"

    if [[ ! "$inst_name" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        echo -e "${RED}名称非法！${NC}"; return;
    fi

    local target_dir="$INSTANCES_DIR/$inst_name"
    if [ -d "$target_dir" ]; then
        echo -e "${RED}目标实例 [$inst_name] 已存在！${NC}"; return;
    fi

    echo -e "${CYAN}>>> [1/4] 停止旧进程...${NC}"
    pm2 delete telebox 2>/dev/null || true
    pkill -f "telebox" 2>/dev/null || true

    echo -e "${CYAN}>>> [2/4] 迁移文件...${NC}"
    mv "$LEGACY_APP_DIR" "$target_dir"

    echo -e "${CYAN}>>> [3/4] 升级环境...${NC}"
    cd "$target_dir"
    npm install --prefer-offline --no-audit

    echo -e "${CYAN}>>> [4/4] 接管配置 (应用内存优化)...${NC}"
    mkdir -p "$target_dir/logs"
    generate_ecosystem "$inst_name" "$target_dir"

    pm2 start ecosystem.config.js
    pm2 save

    echo -e "${GREEN}✔ 导入成功！实例: [$inst_name]${NC}"
    echo -e "内存限制策略: ${MAX_MEMORY}MB (自动GC)"
}

# [功能1] 全新安装
clean_reinstall_all() {
    echo -e "${RED}====================================================${NC}"
    echo -e "${RED}⚠️  警告：[全新安装] 将清除所有 TeleBox 数据${NC}"
    echo -e "${RED}====================================================${NC}"

    read -p "确认执行？(y/N): " confirm
    echo
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then echo "已取消。"; return; fi

    perform_cleanup

    echo -e "${GREEN}>>> 环境已重置。3秒后开始安装...${NC}"
    sleep 3
    mkdir -p "$INSTANCES_DIR"

    add_new_instance
}

# [功能2] 添加新实例
add_new_instance() {
    local default_name="${1:-}"

    echo -e "${BLUE}==== 添加新 TeleBox 实例 ====${NC}"
    echo -e "请输入实例名称 (英文/数字)"

    if [ -n "$default_name" ]; then
        echo -e "默认名称: [ ${default_name} ]"
    fi

    read -p "实例名称: " input_name
    local inst_name="${input_name:-$default_name}"

    if [ -z "$inst_name" ]; then inst_name="telebox_01"; echo -e "自动命名为: ${inst_name}"; fi

    if [[ ! "$inst_name" =~ ^[a-zA-Z0-9_-]+$ ]]; then echo -e "${RED}名称非法${NC}"; return; fi

    local dir="$INSTANCES_DIR/$inst_name"
    if [ -d "$dir" ]; then echo -e "${RED}实例已存在${NC}"; return; fi

    echo -e "${CYAN}>>> [1/5] 创建目录...${NC}"
    mkdir -p "$dir"

    echo -e "${CYAN}>>> [2/5] 克隆代码...${NC}"
    git clone "$GITHUB_REPO" "$dir"

    echo -e "${CYAN}>>> [3/5] 安装依赖...${NC}"
    cd "$dir"
    npm install --prefer-offline --no-audit

    echo -e "${YELLOW}======================================================${NC}"
    echo -e "${YELLOW}>>> [4/5] 交互登录: 看到 Connected 后按 Ctrl+C <<<${NC}"
    echo -e "${YELLOW}======================================================${NC}"
    read -p "按回车继续..."

    echo -e "\n${RED}>>> [等待] 看到 'You should now be connected.' 后 -> 按 Ctrl+C <<<${NC}\n"

    set +e
    trap 'echo -e "\n${GREEN}>>> 收到中断，转入后台...${NC}"' SIGINT
    npm start
    trap - SIGINT
    set -e

    echo -e "\n${CYAN}>>> [5/5] 配置 PM2 (含内存优化)...${NC}"
    mkdir -p "$dir/logs"
    generate_ecosystem "$inst_name" "$dir"

    pm2 start ecosystem.config.js
    pm2 save

    echo -e "${GREEN}✔ 实例 [$inst_name] 启动成功${NC}"
    echo -e "内存限制策略: ${MAX_MEMORY}MB (自动GC)"
}

# [功能3] 无损更新
update_lossless() {
    echo -e "${BLUE}==== 无损更新 ====${NC}"
    local instances=$(get_instances)
    if [ -z "$instances" ]; then echo -e "${YELLOW}无实例。${NC}"; return; fi

    for inst in $instances; do
        echo -e "${CYAN}>>> 更新: [ $inst ] ...${NC}"
        local dir="$INSTANCES_DIR/$inst"
        if [ ! -d "$dir" ]; then continue; fi

        cd "$dir"
        generate_ecosystem "$inst" "$dir"
        pm2 stop ecosystem.config.js 2>/dev/null || true

        local current_branch=$(git rev-parse --abbrev-ref HEAD)
        git pull origin "$current_branch" || echo -e "${RED}Git 失败${NC}"

        npm install --prefer-offline --no-audit
        pm2 restart ecosystem.config.js
        echo -e "${GREEN}✔ $inst 完成${NC}"
    done
}

# [功能4] 无损重装 (核心修复)
reinstall_core_lossless() {
    echo -e "${BLUE}==== 无损重装 (核心) ====${NC}"
    local instances=$(get_instances)
    if [ -z "$instances" ]; then echo -e "${YELLOW}无实例。${NC}"; return; fi

    echo "当前实例: $instances" | xargs
    read -p "输入要重装的实例 (输入 'all' 为所有): " target

    local list_to_process=""
    if [ "$target" == "all" ]; then
        list_to_process=$instances
    else
        if [ ! -d "$INSTANCES_DIR/$target" ]; then echo -e "${RED}不存在。${NC}"; return; fi
        list_to_process=$target
    fi

    for inst in $list_to_process; do
        echo -e "${CYAN}>>> 正在重装: [ $inst ] ...${NC}"
        local dir="$INSTANCES_DIR/$inst"
        local temp_session="/tmp/tb_sess_bk_$inst"

        echo "   - 停止服务..."
        if [ -d "$dir" ]; then
            cd "$dir"
            pm2 delete ecosystem.config.js 2>/dev/null || true
        fi

        echo "   - 备份 Session..."
        rm -rf "$temp_session"
        [ -d "$dir/session" ] && cp -r "$dir/session" "$temp_session"

        # [核心修复点]
        # 在删除目录前，强制切换到上级目录
        # 避免 "Unable to read current working directory" 错误
        cd "$INSTANCES_DIR" || cd "$HOME"

        echo "   - 删除旧文件..."
        rm -rf "$dir"

        echo "   - 重新下载..."
        # 这里的 $dir 已经是绝对路径了，且目录已清空
        git clone "$GITHUB_REPO" "$dir"

        echo "   - 安装依赖..."
        cd "$dir" # 下载完后再次进入
        npm install --prefer-offline --no-audit

        echo "   - 还原 Session..."
        [ -d "$temp_session" ] && mv "$temp_session" "$dir/session"

        echo "   - 恢复服务 (应用内存优化)..."
        mkdir -p "$dir/logs"
        generate_ecosystem "$inst" "$dir"

        pm2 start ecosystem.config.js
        pm2 save
        echo -e "${GREEN}✔ 实例 $inst 重装完毕！${NC}"
    done
}

# [功能5] 内存状态
memory_gc_info() {
    echo -e "${BLUE}==== 内存状态 ====${NC}"
    if command -v pm2 >/dev/null 2>&1; then
        pm2 list | grep -iE "telebox|App name|id" || echo "无运行进程"
    else
        echo "PM2 未运行"
    fi
}

# [功能6] 卸载全部
uninstall_all() {
    echo -e "${RED}==== 卸载全部 ====${NC}"
    read -p "确认删除所有？(y/N): " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then return; fi
    perform_cleanup
}

# ================= 菜单逻辑 =================
show_menu() {
    clear
    echo -e "${BLUE}#############################################${NC}"
    echo -e "${BLUE}#       TeleBox 多实例管理器 (v2.10)        #${NC}"
    echo -e "${BLUE}#############################################${NC}"
    echo -e "1. 全新安装 (彻底清理并新建)"
    echo -e "2. 添加新实例"
    echo -e "3. 无损更新 (保留数据)"
    echo -e "4. 无损重装 (修复核心 & 应用GC)"
    echo -e "5. 查看内存状态"
    echo -e "6. 卸载全部"
    if [ -d "$LEGACY_APP_DIR" ]; then
        echo -e "${YELLOW}7. [发现旧版] 导入旧版 TeleBox${NC}"
    fi
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
        read -p "请选择 [0-7]: " choice
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