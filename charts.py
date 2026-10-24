"""Plotly figure builders (chain charts + intraday charts)."""
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots

RED, GREEN, BLUE, ORANGE = "#e5484d", "#30a46c", "#3b82f6", "#f59e0b"


def _num(df, col):
    return pd.to_numeric(df[col], errors="coerce")


def _nz(df, col):
    s = _num(df, col)
    return s.where(s > 0)  # zero = no trade -> hide


def _spot_line(fig, spot):
    if spot is not None:
        fig.add_vline(x=spot, line_dash="dash", line_color="#888",
                      annotation_text=f"Spot {spot:,.0f}", annotation_position="top")


def _base(fig, title, h=380):
    fig.update_layout(title=title, height=h, margin=dict(l=10, r=10, t=60, b=10),
                      legend=dict(orientation="h", y=1.12, x=0), hovermode="x unified")
    return fig


# ---------------------------------------------------------- chain (per strike)
def oi_by_strike(df, spot):
    fig = go.Figure()
    fig.add_bar(x=df["STRIKE"], y=_num(df, "CE_OI"), name="Call OI", marker_color=RED)
    fig.add_bar(x=df["STRIKE"], y=_num(df, "PE_OI"), name="Put OI", marker_color=GREEN)
    fig.update_layout(barmode="group")
    _spot_line(fig, spot)
    return _base(fig, "Open interest by strike")


def change_in_oi(df, spot):
    fig = go.Figure()
    fig.add_bar(x=df["STRIKE"], y=_num(df, "CE_CHNG_IN_OI"), name="Call chng in OI", marker_color=RED)
    fig.add_bar(x=df["STRIKE"], y=_num(df, "PE_CHNG_IN_OI"), name="Put chng in OI", marker_color=GREEN)
    fig.update_layout(barmode="group")
    _spot_line(fig, spot)
    return _base(fig, "Change in open interest by strike")


def volume_by_strike(df, spot):
    fig = go.Figure()
    fig.add_bar(x=df["STRIKE"], y=_num(df, "CE_VOLUME"), name="Call volume", marker_color=RED)
    fig.add_bar(x=df["STRIKE"], y=_num(df, "PE_VOLUME"), name="Put volume", marker_color=GREEN)
    fig.update_layout(barmode="group")
    _spot_line(fig, spot)
    return _base(fig, "Traded volume by strike")


def iv_smile(df, spot):
    fig = go.Figure()
    fig.add_scatter(x=df["STRIKE"], y=_nz(df, "CE_IV"), name="Call IV", mode="lines+markers",
                    line_color=RED, connectgaps=True)
    fig.add_scatter(x=df["STRIKE"], y=_nz(df, "PE_IV"), name="Put IV", mode="lines+markers",
                    line_color=GREEN, connectgaps=True)
    _spot_line(fig, spot)
    return _base(fig, "Implied volatility by strike (IV smile)")


def premium_by_strike(df, spot):
    fig = go.Figure()
    fig.add_scatter(x=df["STRIKE"], y=_nz(df, "CE_LTP"), name="Call LTP", mode="lines+markers",
                    line_color=RED, connectgaps=True)
    fig.add_scatter(x=df["STRIKE"], y=_nz(df, "PE_LTP"), name="Put LTP", mode="lines+markers",
                    line_color=GREEN, connectgaps=True)
    _spot_line(fig, spot)
    return _base(fig, "Option price (LTP) by strike")


# --------------------------------------------------- intraday (from database)
def spot_pcr(h):
    g = h.groupby("ts").agg(spot=("spot", "first"), ce=("CE_OI", "sum"), pe=("PE_OI", "sum")).reset_index()
    g["pcr"] = g["pe"] / g["ce"].where(g["ce"] != 0)
    fig = make_subplots(specs=[[{"secondary_y": True}]])
    fig.add_trace(go.Scatter(x=g["ts"], y=g["spot"], name="Spot", mode="lines", line_color=BLUE),
                  secondary_y=False)
    fig.add_trace(go.Scatter(x=g["ts"], y=g["pcr"], name="PCR (OI)", mode="lines", line_color=ORANGE),
                  secondary_y=True)
    fig.update_yaxes(title_text="Spot", secondary_y=False)
    fig.update_yaxes(title_text="PCR", secondary_y=True)
    return _base(fig, "Spot price and PCR through the day")


def total_oi(h):
    g = h.groupby("ts").agg(ce=("CE_OI", "sum"), pe=("PE_OI", "sum")).reset_index()
    fig = go.Figure()
    fig.add_scatter(x=g["ts"], y=g["ce"], name="Total call OI", mode="lines", line_color=RED)
    fig.add_scatter(x=g["ts"], y=g["pe"], name="Total put OI", mode="lines", line_color=GREEN)
    return _base(fig, "Total open interest through the day")


def strike_premium(h, strike):
    s = h[h["STRIKE"] == strike]
    fig = go.Figure()
    fig.add_scatter(x=s["ts"], y=s["CE_LTP"], name="Call LTP", mode="lines", line_color=RED)
    fig.add_scatter(x=s["ts"], y=s["PE_LTP"], name="Put LTP", mode="lines", line_color=GREEN)
    return _base(fig, f"Option price through the day - strike {strike:,.0f}")


def strike_oi(h, strike):
    s = h[h["STRIKE"] == strike]
    fig = go.Figure()
    fig.add_scatter(x=s["ts"], y=s["CE_OI"], name="Call OI", mode="lines", line_color=RED)
    fig.add_scatter(x=s["ts"], y=s["PE_OI"], name="Put OI", mode="lines", line_color=GREEN)
    return _base(fig, f"Open interest through the day - strike {strike:,.0f}")
