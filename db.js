import { DataTypes, Sequelize } from 'sequelize';

// 从环境变量中读取数据库配置
const { MYSQL_USERNAME, MYSQL_PASSWORD, MYSQL_ADDRESS = '' } = process.env;
const [host, port] = MYSQL_ADDRESS.split(':');

const sequelize = new Sequelize('nodejs_demo', MYSQL_USERNAME, MYSQL_PASSWORD, {
  host,
  port,
  dialect: 'mysql',
});

// 用于替代 Workers KV 的最小 Key-Value 表（支持 TTL）
export const Kv = sequelize.define(
  'Kv',
  {
    k: {
      type: DataTypes.STRING(512),
      primaryKey: true,
    },
    v: {
      type: DataTypes.TEXT('long'),
      allowNull: false,
    },
    expires_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: 'rumi_kv',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
);

// 数据库初始化方法
export async function init() {
  await Kv.sync({ alter: true });
}

export { sequelize };
