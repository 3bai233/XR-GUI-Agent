import json
import numpy as np
from sklearn.linear_model import LinearRegression
from sklearn.preprocessing import PolynomialFeatures
from sklearn.pipeline import make_pipeline

# 读取数据
with open('calibration.json', 'r') as f:
    data = json.load(f)
points = np.array(data['points'])

# 平面坐标 (x, y)
X = points[:, :2]
# 圆柱面坐标 (u, v)
Y = points[:, 2:]

def fit_models(X, Y, poly_degree=2):
    if poly_degree == 1:
        model_u = LinearRegression().fit(X, Y[:, 0])
        model_v = LinearRegression().fit(X, Y[:, 1])
    else:
        model_u = make_pipeline(PolynomialFeatures(poly_degree), LinearRegression())
        model_u.fit(X, Y[:, 0])
        model_v = make_pipeline(PolynomialFeatures(poly_degree), LinearRegression())
        model_v.fit(X, Y[:, 1])
    return model_u, model_v

# 设置多项式阶数（1为线性，2或更高为多项式）
results = {}
for deg in [1, 2, 3, 4, 5, 6]:
    model_u, model_v = fit_models(X, Y, deg)
    pred_u = model_u.predict(X)
    pred_v = model_v.predict(X)
    pred_Y = np.stack([pred_u, pred_v], axis=1)
    errors = np.linalg.norm(pred_Y - Y, axis=1)
    avg_error = np.mean(errors)
    results[deg] = avg_error
    print(f"\n{deg}阶多项式拟合: 平均偏差 = {avg_error:.2f}")

# 圆柱面参数拟合（用 calibration.json 中 ax, bx, ay, by）
ax, bx, ay, by = data['ax'], data['bx'], data['ay'], data['by']
def cylinder_map(x, y):
    u = ax * x + bx
    v = ay * y + by
    return u, v

cylinder_pred = np.array([cylinder_map(x, y) for x, y in X])
cylinder_errors = np.linalg.norm(cylinder_pred - Y, axis=1)
cylinder_avg_error = np.mean(cylinder_errors)
print(f"\n圆柱面参数拟合: 平均偏差 = {cylinder_avg_error:.2f}")