#!/bin/bash
# TeleBox 多实例管理脚本 (v2.7 迁移增强版)
# 新增功能：
# 1. 自动检测并导入手动安装的旧版 TeleBox (位于 ~/telebox)
# 2. 卸载功能增强：覆盖删除旧版目录
# 3. 修复了对旧版实例“视而不见”的问题
# 适用于 Debian / Ubuntu

set -u

# ================= 配置区域 =================
readonly MANAGER_ROOT="$HOME/telebox_manager"
readonly INSTANCES_DIR="$MANAGER_ROOT/instances"
# 旧版默认安装位置
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

perform_cleanup() {
    echo -e "${BLUE}>>> [清理] 1. 停止并删除相关 PM2 进程...${NC}"
    if command -v pm2 >/dev/null 2>&1; then
        # 宽泛删除，确保旧的 'telebox' 进程也被干掉
        pm2 delete /telebox/ 2>/dev/null || true
        pm2 save >/dev/null 2>&1
    fi

    echo -e "${BLUE}>>> [清理] 2. 删除管理器目录 ($MANAGER_ROOT)...${NC}"
    rm -rf "$MANAGER_ROOT"

    echo -e "${BLUE}>>> [清理] 3. 删除旧版安装目录 ($LEGACY_APP_DIR)...${NC}"
    # 核心修复：增加对旧目录的删除
    rm -rf "$LEGACY_APP_DIR"

    echo -e "${BLUE}>>> [清理] 4. 删除残留配置 ($LEGACY_CONFIG)...${NC}"
    rm -rf "$LEGACY_CONFIG"*

    echo -e "${BLUE}>>> [清理] 5. 删除临时缓存 (/tmp/telebox*)...${NC}"
    rm -rf "/tmp/telebox"*

    echo -e "${GREEN}>>> [清理] 系统清理完毕！${NC}"
}

# ================= 核心功能模块 =================

# [功能7] 导入旧版 (Migration)
import_legacy() {
    if [ ! -d "$LEGACY_APP_DIR" ]; then
        echo -e "${RED}未检测到旧版目录 ($LEGACY_APP_DIR)，无需导入。${NC}"
        return
    fi

    echo -e "${BLUE}==== 导入旧版 TeleBox ====${NC}"
    echo -e "检测到手动安装的旧版本位于: $LEGACY_APP_DIR"
    echo -e "导入后，它将变为受管实例，支持无损更新、重装等功能。"
    echo

    read -p "请为导入的实例命名 (例如: legacy, old): " input_name
    local inst_name="${input_name:-legacy}"

    # 名称检查
    if [[ ! "$inst_name" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        echo -e "${RED}名称非法！${NC}"; return;
    fi

    local target_dir="$INSTANCES_DIR/$inst_name"
    if [ -d "$target_dir" ]; then
        echo -e "${RED}目标实例 [$inst_name] 已存在！请换个名字。${NC}"; return;
    fi

    echo -e "${CYAN}>>> [1/4] 停止旧进程...${NC}"
    pm2 delete telebox 2>/dev/null || true
    pkill -f "telebox" 2>/dev/null || true

    echo -e "${CYAN}>>> [2/4] 迁移文件到新目录...${NC}"
    # 移动旧目录到新架构下
    mv "$LEGACY_APP_DIR" "$target_dir"

    echo -e "${CYAN}>>> [3/4] 升级环境与依赖...${NC}"
    cd "$target_dir"
    # 确保 npm 依赖是新的
    npm install --prefer-offline --no-audit

    echo -e "${CYAN}>>> [4/4] 生成新配置并接管...${NC}"
    mkdir -p "$target_dir/logs"
    generate_ecosystem "$inst_name" "$target_dir"

    pm2 start ecosystem.config.js
    pm2 save

    echo -e "${GREEN}✔ 导入成功！旧版已迁移为实例: [$inst_name]${NC}"
    echo -e "现在你可以对它使用更新、重装等功能了。"
}

# [功能1] 全新安装
clean_reinstall_all() {
    echo -e "${RED}====================================================${NC}"
    echo -e "${RED}⚠️  警告：[全新安装] 将执行以下操作：${NC}"
    echo -e "${RED}1. 彻底清除所有 TeleBox (含旧版和新版)${NC}"
    echo -e "${RED}2. 重新初始化环境${NC}"
    echo -e "${RED}====================================================${NC}"

    read -p "确认要执行全新安装吗？(输入 y 并回车): " confirm
    echo
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then echo "操作已取消。"; return; fi

    perform_cleanup

    echo -e "${GREEN}>>> 环境已重置。3秒后开始安装新实例...${NC}"
    sleep 3
    mkdir -p "$INSTANCES_DIR"

    add_new_instance
}

# [功能2] 添加新实例
add_new_instance() {
    local default_name="${1:-}"

    echo -e "${BLUE}==== 添加新 TeleBox 实例 ====${NC}"
    echo -e "请输入新实例的名称 (英文/数字，如: telebox-2, work)"

    if [ -n "$default_name" ]; then
        echo -e "按回车默认使用名称: [ ${default_name} ]"
    fi

    read -p "实例名称: " input_name

    local inst_name="${input_name:-$default_name}"

    if [ -z "$inst_name" ]; then
        inst_name="telebox_01"
        echo -e "${YELLOW}未检测到输入，将自动命名为: ${inst_name}${NC}"
    fi

    if [[ ! "$inst_name" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        echo -e "${RED}名称非法！仅支持字母、数字、下划线。请重试。${NC}"
        return
    fi

    local dir="$INSTANCES_DIR/$inst_name"
    if [ -d "$dir" ]; then
        echo -e "${RED}实例 [$inst_name] 已存在！请更换名称。${NC}"
        return
    fi

    echo -e "${CYAN}>>> [1/5] 正在创建目录: $dir ...${NC}"
    mkdir -p "$dir"

    echo -e "${CYAN}>>> [2/5] 正在克隆代码 (GitHub)...${NC}"
    git clone "$GITHUB_REPO" "$dir"

    echo -e "${CYAN}>>> [3/5] 正在安装依赖 (npm install)...${NC}"
    cd "$dir"
    npm install --prefer-offline --no-audit

    echo -e "${YELLOW}======================================================${NC}"
    echo -e "${YELLOW}>>> [4/5] 交互式登录 (请仔细阅读) <<<${NC}"
    echo -e "1. 输入手机号和验证码登录"
    echo -e "2. 当看到日志显示: ${GREEN}You should now be connected.${NC}"
    echo -e "3. ${RED}必须手动按 Ctrl+C 结束前台进程${NC}，脚本才会继续！"
    echo -e "${YELLOW}======================================================${NC}"

    read -p "我已理解，看到连接成功后按 Ctrl+C (按回车继续)..."
    echo -e "\n${RED}>>> [等待登录] 看到 'You should now be connected.' 后 -> 请立即按 Ctrl+C <<<${NC}\n"

    set +e
    trap 'echo -e "\n${GREEN}>>> 检测到用户中断 (Ctrl+C)，正在转入后台配置...${NC}"' SIGINT
    npm start
    trap - SIGINT
    set -e

    echo -e "\n${CYAN}>>> [5/5] 正在配置 PM2 后台托管...${NC}"
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
    if [ -z "$instances" ]; then echo -e "${YELLOW}无管理实例。如需更新旧版，请先执行[7. 导入旧版]。${NC}"; return; fi

    for inst in $instances; do
        echo -e "${CYAN}>>> 正在处理实例: [ $inst ] ...${NC}"
        local dir="$INSTANCES_DIR/$inst"

        if [ ! -d "$dir" ]; then continue; fi
        cd "$dir"

        echo "   - 更新配置..."
        generate_ecosystem "$inst" "$dir"
        echo "   - 停止服务..."
        pm2 stop ecosystem.config.js 2>/dev/null || true

        echo "   - 拉取代码..."
        local current_branch=$(git rev-parse --abbrev-ref HEAD)
        git pull origin "$current_branch" || echo -e "${RED}Git 拉取失败${NC}"

        echo "   - 更新依赖..."
        npm install --prefer-offline --no-audit
        echo "   - 重启服务..."
        pm2 restart ecosystem.config.js
        echo -e "${GREEN}✔ $inst 更新完成${NC}"
    done
}

# [功能4] 无损重装
reinstall_core_lossless() {
    echo -e "${BLUE}==== 无损重装 (保留登录，重装核心) ====${NC}"
    local instances=$(get_instances)
    if [ -z "$instances" ]; then echo -e "${YELLOW}无管理实例。如需重装旧版，请先执行[7. 导入旧版]。${NC}"; return; fi

    echo "当前实例: $instances" | xargs
    read -p "输入要重装的实例名称 (输入 'all' 重装所有): " target

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
        cd "$dir" 2>/dev/null && pm2 delete ecosystem.config.js 2>/dev/null || true

        echo "   - 备份 Session..."
        rm -rf "$temp_session"
        [ -d "$dir/session" ] && cp -r "$dir/session" "$temp_session"

        echo "   - 删除旧文件..."
        rm -rf "$dir"
        mkdir -p "$dir"

        echo "   - 重新下载..."
        git clone "$GITHUB_REPO" "$dir"
        cd "$dir"
        npm install --prefer-offline --no-audit

        echo "   - 还原 Session..."
        [ -d "$temp_session" ] && mv "$temp_session" "$dir/session"

        echo "   - 恢复服务..."
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
        pm2 list | grep -iE "telebox|App name|id" || echo "无运行中的 TeleBox 进程"
    else
        echo "PM2 未运行"
    fi
}

# [功能6] 卸载全部
uninstall_all() {
    echo -e "${RED}==== 卸载全部 ====${NC}"
    echo -e "${RED}警告：这将删除所有管理器实例 AND 旧版安装目录 ($LEGACY_APP_DIR)${NC}"
    read -p "确认彻底删除？(y/N): " confirm
    if [[ ! "$confirm" =~ ^[Yy]$ ]]; then return; fi
    perform_cleanup
}

# ================= 菜单逻辑 =================
show_menu() {
    clear
    echo -e "${BLUE}#############################################${NC}"
    echo -e "${BLUE}#       TeleBox 多实例管理器 (v2.7)         #${NC}"
    echo -e "${BLUE}#############################################${NC}"
    echo -e "1. 全新安装 (彻底清理旧版/新版并新建)"
    echo -e "2. 添加新实例 (自定义命名)"
    echo -e "3. 无损更新 (仅限已导入的实例)"
    echo -e "4. 无损重装 (仅限已导入的实例)"
    echo -e "5. 查看内存状态"
    echo -e "6. 卸载全部 (含旧版清理)"

    # 动态显示导入选项
    if [ -d "$LEGACY_APP_DIR" ]; then
        echo -e "${YELLOW}7. [✨发现旧版] 导入旧版 TeleBox${NC}"
    fi

    echo -e "0. 退出"
    echo -e "${BLUE}#############################################${NC}"
    local instances=$(get_instances)
    echo -e "当前受管实例: ${YELLOW}${instances:-无}${NC}"
    if [ -d "$LEGACY_APP_DIR" ]; then
        echo -e "未导入旧版: ${RED}存在 (在 ~/telebox)${NC}"
    fi
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