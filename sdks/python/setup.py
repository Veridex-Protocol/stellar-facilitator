"""
Veridex Stellar x402 SDK - Python helpers for sellers and buyers
"""

from setuptools import setup, find_packages

setup(
    name="veridex-stellar-sdk",
    version="0.1.0",
    description="Veridex Stellar x402 SDK - Python helpers for sellers and buyers",
    author="Veridex Protocol Team",
    author_email="omoebun52@gmail.com",
    url="https://github.com/veridex-protocol/veridex",
    license="Apache-2.0",
    packages=find_packages(),
    python_requires=">=3.8",
    keywords=["veridex", "x402", "stellar", "bazaar", "sdk"],
    classifiers=[
        "Development Status :: 3 - Alpha",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: Apache Software License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.8",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
    ],
)
