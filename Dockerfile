# 二开推荐阅读[如何提高项目构建效率](https://developers.weixin.qq.com/miniprogram/dev/wxcloudrun/src/scene/build/speed.html)
FROM node:18-alpine

# 容器默认时区为UTC，如需使用上海时间请自行配置 tzdata。

WORKDIR /app

COPY package*.json /app/

# npm 源（可按需调整）
RUN npm config set registry https://mirrors.cloud.tencent.com/npm/

RUN npm install

COPY . /app

CMD ["npm", "start"]
