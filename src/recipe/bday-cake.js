// language=XML
const xml_data = `<?xml version="1.0" encoding="utf-8" ?>
<recipe ref="https://www.wearesovegan.com/epic-microwave-chocolate-cake/">
    <title>Birthday cake</title>
    <ingredients>
        <ingredient id="oat-milk" name="oat milk"/>
        <ingredient id="white-chocolate-spread" name="white chocolate spread"/>
        <ingredient id="instant-coffee" name="instant coffee"/>
        <ingredient id="flour" name="flour"/>
        <ingredient id="baking-powder" name="baking powder"/>
        <ingredient id="caster-sugar" name="caster sugar"/>
        <ingredient id="vegan-cream" name="vegan cream"/>
        <ingredient id="vegan-yoghurt" name="vegan yoghurt"/>
        <ingredient id="margarine" name="margarine"/>
        <ingredient id="cucumber" name="cucumber"/>
        <ingredient id="cream-of-tartar" name="cream of tartar"/>
        <ingredient id="salt" name="salt"/>
        <ingredient id="raspberries" name="raspberries"/>
        <ingredient id="ground-coriander" name="ground coriander"/>
        <ingredient id="gin" name="gin"/>
        <ingredient id="xanthan" name="xanthan"/>
        <ingredient id="lime" name="lime"/>
    </ingredients>
    <tools>
        <tool id="silicone-cake-mould" name="silicone cake mould">
            <properties>
                <property name="circumference">
                    <numeric-value number="20" unit="centimeters"/>
                </property>
            </properties>
        </tool>
        <tool id="microwave-safe-jug" name="microwave safe jug"/>
        <tool id="spatula" name="spatula"/>
        <tool id="bowl" name="bowl"/>
        <tool id="cup" name="cup"/>
        <tool id="whisk" name="whisk"/>
        <tool id="frosting-spatula" name="frosting spatula"/>
        <tool id="cooling-rack" name="cooling rack"/>
        <tool id="precision-scale" name="precision scale"/>
        <tool id="kitchen-scale" name="kitchen scale"/>
        <tool id="plate" name="plate"/>
        <tool id="spoon" name="spoon"/>
        <tool id="fork" name="fork"/>
        <tool id="serving-plate" name="serving plate"/>
        <tool id="fruit-baller" name="fruit baller"/>
        <tool id="microwave-oven" name="microwave oven"/>
    </tools>
    <tasks>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="40" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="cup"/>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="oat-milk"/>
            </inputs>
            <outputs>
                <output id="oat-milk-for-coffee" name="oat milk for coffee"/>
                <!-- TODO: How to differentiate different measurements of same ingredient? -->
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="100" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="bowl"/>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="oat-milk"/>
            </inputs>
            <outputs>
                <output id="oat-milk-for-batter" name="oat milk for batter"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="20" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="cup"/>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="white-chocolate-spread"/>
            </inputs>
            <outputs>
                <output id="white-chocolate-spread-for-filling" name="white chocolate for filling"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="20" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="cup"/>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="white-chocolate-spread"/>
            </inputs>
            <outputs>
                <output id="white-chocolate-spread-for-frosting" name="white chocolate spread for frosting"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="20" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="cup"/>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="vegan-yoghurt"/>
            </inputs>
            <outputs>
                <output id="vegan-yoghurt-for-frosting" name="vegan yoghurt"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="8" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="cup"/>
                <tool ref="precision-scale"/>
            </tools>
            <inputs>
                <input ref="instant-coffee"/>
            </inputs>
            <outputs>
                <output id="measured-instant-coffee" name="instant coffee"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="170" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="bowl"/>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="margarine"/>
            </inputs>
            <outputs>
                <output id="measured-margarine" name="margarine"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="20" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="cup"/>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="margarine"/>
            </inputs>
            <outputs>
                <output id="margarine-for-greasing" name="margarine"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="220" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="bowl"/>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="flour"/>
            </inputs>
            <outputs>
                <output id="measured-flour" name="flour"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="100" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="bowl"/>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="caster-sugar"/>
            </inputs>
            <outputs>
                <output id="measured-caster-sugar" name="caster sugar"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="100" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="cup"/>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="vegan-cream"/>
            </inputs>
            <outputs>
                <output id="vegan-cream-for-frosting" name="vegan cream"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="1" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="cup"/>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="cream-of-tartar"/>
            </inputs>
            <outputs>
                <output id="measured-cream-of-tartar" name="cream of tartar"/>
            </outputs>
        </task>

        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="4" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="cup"/>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="ground-coriander"/>
            </inputs>
            <outputs>
                <output id="measured-ground-coriander" name="coriander"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="4" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="cup"/>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="salt"/>
            </inputs>
            <outputs>
                <output id="salt-for-batter" name="salt for batter"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="4" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="cup"/>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="xanthan"/>
            </inputs>
            <outputs>
                <output id="measured-xanthan" name="xanthan"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="4" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="cup"/>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="baking-powder"/>
            </inputs>
            <outputs>
                <output id="measured-baking-powder" name="baking powder"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="200" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="plate"/>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="cucumber"/>
            </inputs>
            <outputs>
                <output id="measured-cucumber" name="cucumber for filling"/>
            </outputs>
        </task>

        <task operation="soften">
            <instructions>
                Soften the
                <input ref="measured-margarine"/>
                with a
                <tool ref="fork" reserved="true"/>
                in a
                <tool ref="bowl"/>.
            </instructions>
            <outputs>
                <output id="softened-margarine" name="softened margarine"/>
            </outputs>
        </task>

        <task operation="cream">
            <instructions>
                Whip the
                <input ref="softened-margarine"/>
                with
                <input ref="measured-caster-sugar"/>
                using a
                <tool ref="whisk" reserved="true"/>
                until light and fluffy.
            </instructions>
            <outputs>
                <output id="creamed-margarine-and-sugar" name="creamed margarine and sugar"/>
            </outputs>
        </task>

        <task operation="heat">
            <options>
                <option name="temperature">
                    <numeric-value number="60" unit="celsius"/>
                </option>
                <option name="duration">
                    <numeric-value number="30" unit="seconds"/>
                </option>
            </options>
            <tools>
                <tool ref="microwave-oven"/>
            </tools>
            <inputs>
                <input ref="oat-milk-for-coffee"/>
            </inputs>
            <outputs>
                <output id="heated-oat-milk" name="heated oat milk"/>
            </outputs>
        </task>

        <task operation="mix">
            <instructions>
                Add the
                <input ref="measured-instant-coffee"/>
                to
                <input ref="heated-oat-milk"/>
                and stir with a
                <tool ref="spoon" reserved="true"/>.
            </instructions>
            <outputs>
                <output id="oat-milk-coffee" name="oat milk coffee"/>
            </outputs>
        </task>

        <task operation="mix">
            <instructions>
                Add the
                <input ref="measured-flour"/>,
                <input ref="measured-baking-powder"/>,
                <input ref="salt-for-batter"/>,
                <input ref="measured-xanthan"/>
                and
                <input ref="measured-ground-coriander"/>
                to
                <tool ref="bowl" reserved="true"/>
                and stir with a
                <tool ref="spatula" reserved="true"/>.
            </instructions>
            <outputs>
                <output id="dry-ingredients" name="dry ingredients"/>
            </outputs>
        </task>
        <task operation="mix">
            <instructions>
                Mix the
                <input ref="dry-ingredients"/>
                into the
                <input ref="creamed-margarine-and-sugar"/>.
            </instructions>
            <outputs>
                <output id="butter-sugar-dry-ingredient-mix" name="butter, sugar and dry ingredients mix"/>
            </outputs>
        </task>
        <task operation="mix">
            <instructions>
                First, add the
                <input ref="oat-milk-for-batter"/>
                into the
                <input ref="butter-sugar-dry-ingredient-mix"/>
                and stir with a
                <tool ref="spatula"/>
                until smooth. Then add the
                <input ref="oat-milk-coffee"/>
                and, again, mix until smooth.
            </instructions>
            <outputs>
                <output id="batter" name="batter"/>
                <tool ref="bowl"/> <!-- TODO: need to be specific about which bowl is freed! -->
                <tool ref="microwave-safe-jug"/>
            </outputs>
        </task>

        <task operation="grease">
            <instructions>
                Grease the sides of a
                <tool ref="silicone-cake-mould" reserved="true"/>
                with
                <input ref="margarine-for-greasing"/>.
            </instructions>
            <outputs>
                <output id="prepared-cake-mould" name="prepared cake mould"/>
            </outputs>
        </task>
        <task operation="split">
            <options>
                <option name="parts">
                    <numeric-value number="2"/>
                </option>
            </options>
            <inputs>
                <input ref="batter"/>
            </inputs>
            <tools>
                <tool ref="bowl" reserved="true"/>
            </tools>
            <outputs>
                <output id="split-batter-in-a-bowl" name="split batter"/>
            </outputs>
        </task>
        <task operation="pour">
            <instructions>
                Pour the
                <input ref="split-batter-in-a-bowl"/>
                into the
                <input ref="prepared-cake-mould">cake mould
                </input> <!-- TODO: this is a input, but also a tool, so which tag to use? -->
            </instructions>
            <outputs>
                <output id="batter-in-mould" name="cake mould with batter"/>
                <tool ref="bowl" name="used bowl"/>
            </outputs>
        </task>
        <task operation="bake-in-microwave"> <!-- operation is identical to heat -->
            <instructions>
                Bake the
                <input ref="batter-in-mould"/>
                in the
                <tool ref="microwave-oven"/>
                with
                <option name="power">
                    <numeric-value number="700" unit="watts"/>
                </option>
                for
                <option name="duration">
                    <numeric-value number="4" unit="minutes"/>
                </option>
                or until a toothpick comes out clean.
            </instructions>
            <outputs>
                <output id="baked-cake" name="baked cake"/>
            </outputs>
        </task>
        <task operation="chill"><!-- should there be a combined take out -operation? -->
            <instructions>
                Cool the
                <input ref="baked-cake"/>
                for
                <option name="duration">
                    <numeric-value number="10" unit="minutes"/><!-- TODO: was 10 minutes -->
                </option>
                in the <tool ref="silicone-cake-mould">mould</tool>.
            </instructions>
            <outputs>
                <output id="cooled-cake-in-mould" name="cooled cake in moulds"/>
            </outputs>
        </task>
        <task operation="separate">
            <instructions>
                Detach the
                <input ref="cooled-cake-in-mould">cooled cakes</input>
                from the mould by running a
                <tool ref="spatula"/>
                around the edges. Turn out the cake from the mould onto a
                <tool ref="serving-plate"/>.
            </instructions>
            <outputs>
                <output id="cake-on-a-plate" name="cake on a plate"/>
                <tool ref="silicone-cake-mould" name="used cake mould"/>
            </outputs>
        </task>

        <task operation="grate">
            Grate the
            <input ref="measured-cucumber"/>
            into a
            <tool ref="sieve"/>
            on top of a
            <tool ref="bowl"/>.
            <outputs>
                <!-- TODO: this creates two grate tasks -->
                <output id="grated-cucumber" name="grated cucumber"/>
                <output id="cucumber-juice" name="cucumber juice"/>
            </outputs>
        </task>

        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="40" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="cup"/>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="vegan-yoghurt"/>
            </inputs>
            <outputs>
                <output id="measured-vegan-yoghurt" name="yoghurt for filling"/>
            </outputs>
        </task>

        <task operation="mix">
            <instructions>
                Mix the
                <input ref="grated-cucumber"/>,
                <input ref="measured-vegan-yoghurt"/>
                and
                <input ref="white-chocolate-spread-for-filling"/>
                in a
                <tool ref="bowl" reserved="true"/>
            </instructions>
            <outputs>
                <output id="filling" name="filling"/>
            </outputs>
        </task>

        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="40" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="cup"/>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="cucumber-juice"/>
            </inputs>
            <outputs>
                <output id="measured-cucumber-juice" name="cucumber juice for filling"/>
            </outputs>
        </task>

        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="20" unit="g"/>
                </option>
            </options>
            <tools>
                <tool ref="cup"/>
                <tool ref="kitchen-scale"/>
            </tools>
            <inputs>
                <input ref="gin"/>
            </inputs>
            <outputs>
                <output id="measured-gin" name="gin"/>
            </outputs>
        </task>

        <task operation="mix">
            <instructions>
                Add
                <input ref="measured-gin"/>
                to the
                <input ref="measured-cucumber-juice"/>
            </instructions>
            <outputs>
                <output id="cucumber-gin-mix" name="cucumber gin mix"/>
            </outputs>
        </task>
        <task operation="fill">
            <instructions>
                Brush the
                <input ref="cake-on-a-plate">cake</input>
                lightly with the
                <input ref="cucumber-gin-mix"/>.
                Spread the
                <input ref="filling"/>
                over the top and place the second
                <input ref="cake-on-a-plate">cake</input>
                on top of the filling. Brush also the top of the cake.
            </instructions>
            <outputs>
                <output id="filled-cake" name="filled cake"/>
                <tool ref="spatula"/>
            </outputs>
        </task>
        <task operation="mix">
            <instructions>
                Add
                <input ref="vegan-cream-for-frosting"/>
                and
                <input ref="measured-cream-of-tartar"/>
                into a
                <tool ref="bowl"/>
            </instructions>
            <outputs>
                <output id="cream-tartar-mix" name="cream tartar mix"/>
            </outputs>
        </task>
        <task operation="whip">
            <instructions>
                Whip the
                <input ref="cream-tartar-mix"/>
                using a
                <tool ref="whisk"/>
                until soft peaks form.
            </instructions>
            <outputs>
                <output id="softly-whisked-cream" name="softly whipped cream"/>
            </outputs>
        </task>
        <task operation="mix">
            <instructions>
                Add
                <input ref="white-chocolate-spread-for-frosting"/>
                and
                <input ref="vegan-yoghurt-for-frosting"/>
                to the
                <input ref="softly-whisked-cream"/>.
            </instructions>
            <outputs>
                <output id="white-chocolate-cream-yoghurt-mix" name="white chocolate, cream and yoghurt mix"/>
            </outputs>
        </task>
        <task operation="whip">
            <instructions>
                Whip the
                <input ref="white-chocolate-cream-yoghurt-mix"/>
                until hard peaks form using a
                <tool ref="whisk" reserved="true"/>.
            </instructions>
            <outputs>
                <output id="frosting" name="frosting"/>
            </outputs>
        </task>
        <task operation="spread">
            <instructions>
                Add the
                <input ref="frosting"/>
                on top of the center of the
                <input ref="filled-cake">cake</input>
                and use a
                <tool ref="frosting-spatula"/>
                to ease it around the sides.
            </instructions>
            <outputs>
                <output id="frosted-cake" name="frosted cake"/>
            </outputs>
        </task>

        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="10" unit="cm"/>
                </option>
            </options>
            <inputs>
                <tool ref="plate"/>
                <input ref="cucumber"/>
            </inputs>
            <outputs>
                <output id="cucumber-for-decorations" name="cucumber for decorations"/>
            </outputs>
        </task>
        <task operation="ball">
            <instructions>
                Use a
                <tool ref="fruit-baller"/>
                to make balls from the
                <input ref="cucumber-for-decorations"/>
            </instructions>
            <outputs>
                <output id="cucumber-balls" name="cucumber balls"/>
            </outputs>
        </task>

        <task operation="decorate">
            <instructions>
                Place the
                <input ref="cucumber-balls"/>
                and
                <input ref="raspberries"/>
                on top of the
                <input ref="frosted-cake"/>.
            </instructions>
            <outputs>
                <output id="decorated-cake" name="decorated cake"/>
            </outputs>
        </task>

        <task operation="grate">
            <inputs>
                <input ref="lime"/>
            </inputs>
            <tools>
                <tool ref="grater"/>
                <tool ref="bowl"/>
            </tools>
            <outputs>
                <output id="lime-curls" name="lime curls"/>
            </outputs>
        </task>

        <task operation="sprinkle">
            <instructions>
                Sprinkle
                <input ref="lime-curls"/>
                on top of the
                <input ref="decorated-cake">cake</input>
            </instructions>
            <outputs>
                <output id="finished-cake" name="birthday cake"/>
            </outputs>
        </task>
        <task operation="enjoy">
            <instructions>
                Enjoy the <input ref="finished-cake"/> and celebrate!
            </instructions>
            <outputs>
                <output id="great-fun" name="great fun"/>
            </outputs>
        </task>
    </tasks>
</recipe>`

export default xml_data
