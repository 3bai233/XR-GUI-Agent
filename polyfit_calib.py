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
# 真实坐标 (u, v)
Y = points[:, 2:]

# 二次多项式拟合
for poly_degree in [2, 3]:
    model_u = make_pipeline(PolynomialFeatures(poly_degree), LinearRegression())
    model_u.fit(X, Y[:, 0])
    model_v = make_pipeline(PolynomialFeatures(poly_degree), LinearRegression())
    model_v.fit(X, Y[:, 1])

    coefs_u = model_u.named_steps['linearregression'].coef_
    intercept_u = model_u.named_steps['linearregression'].intercept_
    coefs_v = model_v.named_steps['linearregression'].coef_
    intercept_v = model_v.named_steps['linearregression'].intercept_

    n_terms = len(coefs_u)
    print(f"\n# {poly_degree}次多项式拟合结果 (u=bt_x, v=bt_y):")
    print(f"# u = c0 + c1*x + c2*y + ... (共{n_terms}项)")
    print(f"# v = d0 + d1*x + d2*y + ... (共{n_terms}项)")
    print("u:", " ".join(f"{c:.8f}" for c in [intercept_u] + list(coefs_u[1:])))
    print("v:", " ".join(f"{c:.8f}" for c in [intercept_v] + list(coefs_v[1:])))

    # 保存到 calibration_poly{poly_degree}.json
    polyfit = {
        "u": [float(intercept_u)] + [float(coefs_u[i]) for i in range(1, n_terms)],
        "v": [float(intercept_v)] + [float(coefs_v[i]) for i in range(1, n_terms)],
        "degree": poly_degree,
        "points": data['points'],
        "screen_size": data.get('screen_size', None)
    }
    fname = f'calibration_poly{poly_degree}.json'
    with open(fname, 'w') as f:
        json.dump(polyfit, f, indent=2)
    print(f"已保存到 {fname}")
