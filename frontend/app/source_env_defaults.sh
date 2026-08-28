source_env_defaults() {
    local env_file="$1"
    local line
    local key
    local -a keys=()
    local -A inherited_values=()
    local -A inherited_present=()

    while IFS= read -r line || [ -n "$line" ]; do
        if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*= ]]; then
            key="${BASH_REMATCH[2]}"
            keys+=("$key")
            if [[ -v "$key" ]]; then
                inherited_present["$key"]=1
                inherited_values["$key"]="${!key}"
            fi
        fi
    done < "$env_file"

    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a

    for key in "${keys[@]}"; do
        if [[ -n "${inherited_present[$key]:-}" ]]; then
            export "$key=${inherited_values[$key]}"
        fi
    done
}
