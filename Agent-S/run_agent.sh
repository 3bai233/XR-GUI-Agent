export OPENAI_API_KEY=5c23f5a5-be32-4155-b1ab-88aa8b9de9a7
export OPENAI_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
agent_s \
    --provider openai \
    --model doubao-seed-2-0-pro-260215 \
    --model_url https://ark.cn-beijing.volces.com/api/v3 \
    --model_api_key 5c23f5a5-be32-4155-b1ab-88aa8b9de9a7 \
    --ground_provider vllm \
    --ground_url http://127.0.0.1:8888/v1 \
    --ground_api_key dummy \
    --ground_model MAI-UI-8B \
    --grounding_width 1000 \
    --grounding_height 1000