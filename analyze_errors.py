import json
import os

results_path = 'eval/results/results-run-20260420-025007.json'
raw_dir = 'eval/run/run-20260420-025007/raw/'

with open(results_path, 'r') as f:
    data = json.load(f)

results_list = data.get('results', [])
error_cases = []

for item in results_list:
    case_id = item.get('case_id')
    # Use criteria: any of baseline_invalid_tools, search_agent_invalid_tools, gitnexus_invalid_tools is non-empty
    if item.get('baseline_invalid_tools') or item.get('search_agent_invalid_tools') or item.get('gitnexus_invalid_tools'):
        error_cases.append(case_id)
    # Also some might have failure_bucket in raw files even if not explicitly in the results list (though usually they align)

# Ensure we have about 9 errors as per summary
if len(error_cases) < 9:
    # If not enough, maybe some cases just didn't finish (not in results_list?)
    # But usually 'errors' in summary means they are identified.
    pass

output_data = []

for case_id in error_cases:
    violation_points = []
    
    # Try to extract details from raw files
    for group in ['baseline', 'search_agent', 'gitnexus']:
        raw_file = os.path.join(raw_dir, f"{case_id}_{group}.json")
        if os.path.exists(raw_file):
            with open(raw_file, 'r') as f:
                raw_data = json.load(f)
                fb = raw_data.get('failure_bucket', [])
                it = raw_data.get('invalid_tools', [])
                if fb: violation_points.append(f"{group} failure: {fb}")
                if it: violation_points.append(f"{group} invalid: {it}")
        else:
            # Check the summary item itself if raw file is missing
            for item in results_list:
                if item['case_id'] == case_id:
                    it = item.get(f'{group}_invalid_tools', [])
                    if it: violation_points.append(f"{group} invalid (from summary): {it}")

    # Deduplicate violation points
    violation_points = list(dict.fromkeys(violation_points))

    suggestions = []
    if any("gitnexus_list_repos" in str(v) for v in violation_points):
        suggestions.append("将 gitnexus_list_repos 纳入 allowed_tools 集合以支持组织级仓库发现")
    if any("list_repos" in str(v) for v in violation_points) and not suggestions:
        suggestions.append("在 Prompt 中增加禁止在未指定组织时调用 list_repos 的显式指令")
    if any("missing" in str(v).lower() for v in violation_points) or not suggestions:
        suggestions.append("增加 no_tool_call 最小调用兜底逻辑，且在补全 repo 参数失败时自动回退")
    if not suggestions:
        suggestions.append("优化 tool_sequence 逻辑，确保基座模型在参数缺失时能通过上下文自动补全 repo 字段")

    current_errors = 9
    new_errors = current_errors - 1
    benefit = f"预计可恢复计分case数: 1; 对错误率的影响: {current_errors}/47 到 {new_errors}/47"
    
    output_data.append({
        "case_id": case_id,
        "violation_points": violation_points,
        "fix_suggestion": suggestions,
        "expected_benefit": benefit,
        "priority": "High" if "invalid" in str(violation_points) else "Medium"
    })

print(json.dumps(output_data, indent=2, ensure_ascii=True))
