export const adversarialScripts: string[] = [
  "online_gsm8k_exact_answer_contract.jsonl",
  "online_boolq_true_false_contract.jsonl",
  "online_arc_challenge_answerkey_contract.jsonl",
  "online_arc_easy_answerkey_contract.jsonl",
  "online_commonsenseqa_answerkey_contract.jsonl",
  "online_openbookqa_answerkey_contract.jsonl",
  "online_winogrande_option_contract.jsonl",
  "online_svamp_exact_answer_contract.jsonl",
  "online_asdiv_exact_answer_contract.jsonl",
  "online_hellaswag_label_contract.jsonl"
];

export const scriptLabels: Record<string, string> = {
  "online_gsm8k_exact_answer_contract.jsonl": "GSM8K Exact-Answer Contract",
  "online_boolq_true_false_contract.jsonl": "BoolQ True/False Contract",
  "online_arc_challenge_answerkey_contract.jsonl": "ARC Challenge Label Contract",
  "online_arc_easy_answerkey_contract.jsonl": "ARC Easy Label Contract",
  "online_commonsenseqa_answerkey_contract.jsonl": "CommonsenseQA Label Contract",
  "online_openbookqa_answerkey_contract.jsonl": "OpenBookQA Label Contract",
  "online_winogrande_option_contract.jsonl": "WinoGrande Option Contract",
  "online_svamp_exact_answer_contract.jsonl": "SVAMP Exact-Answer Contract",
  "online_asdiv_exact_answer_contract.jsonl": "ASDiv Exact-Answer Contract",
  "online_hellaswag_label_contract.jsonl": "HellaSwag Label Contract"
};

export const promptCountOptions: Array<{ value: number; label: string }> = [
  { value: 25, label: "25" },
  { value: 50, label: "50" },
  { value: 100, label: "100" },
  { value: 250, label: "250" },
  { value: 500, label: "500" },
  { value: 1000, label: "1000" },
  { value: 2000, label: "2000" },
  { value: 5000, label: "5000" },
  { value: 0, label: "All (Full Script)" }
];
