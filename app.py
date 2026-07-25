from flask import send_from_directory
from marjon_app import create_app

app = create_app()


@app.route("/mijoz")
def mijoz():
    return send_from_directory(".", "mijoz-faollik.html")


if name == "main":
    app.run(
        host="0.0.0.0",
        port=5000,
        debug=app.config.get("APP_ENV") != "production"
    )
